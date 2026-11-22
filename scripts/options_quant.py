#!/usr/bin/env python3
"""
options_quant.py
================
Camada quant da página de opções, calculada com o financial-analysis-framework
(pacote ``faf``).

Para um ativo-objeto, devolve em JSON:
  * leitura do ativo: regime bayesiano, vol realizada 30d, Selic;
  * por vencimento: Monte Carlo (P(alta), faixa 90%) e VI ATM;
  * por série: VI, delta, preço justo (binomial americano com a vol realizada),
    mercado × justo (%) e P(exercício) pelo Monte Carlo.

O resultado fica em cache por ativo e data de referência do COTAHIST
(data/quant/<TICKER>_<data>.json), então só o primeiro acesso do dia calcula.

Uso:
    python3 scripts/options_quant.py VALE3
"""
from __future__ import annotations

import json
import math
import os
import sys
import time
from datetime import date, datetime
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT_DIR / "data"
COTAHIST_JSON = DATA_DIR / "cotahist.json"
QUANT_DIR = DATA_DIR / "quant"
FAF_CACHE = DATA_DIR / "faf_cache"

SELIC_FALLBACK = float(os.environ.get("SELIC_FALLBACK", "13.75"))  # % a.a.
N_SIMULATIONS = 20_000
HIST_DAYS = 252          # janela para regime e Monte Carlo
RV_WINDOW = 30           # vol realizada
ATM_BAND = 0.02          # mesmo critério do site (±2%)


def out(payload: dict, code: int = 0) -> None:
    print(json.dumps(payload, ensure_ascii=False))
    sys.exit(code)


try:
    import numpy as np
    import pandas as pd
    from faf.analysis.bayesian.regime_detection import BayesianRegimeDetector
    from faf.analysis.forecasting import MonteCarloForecast
    from faf.analysis.options import binomial_price, black_scholes, implied_volatility
    from faf.data.collectors.cotahist_collector import CotahistCollector
    from faf.data.processors.calendar import b3_holidays
except ImportError as exc:  # faf não instalado na imagem
    out({"disponivel": False, "motivo": f"financial-analysis-framework não instalado ({exc.name})"})

try:
    from importlib.metadata import version as _pkg_version
    FAF_VERSION = _pkg_version("financial-analysis-framework")
except Exception:
    FAF_VERSION = "?"


# ---------------------------------------------------------------------------
# Entrada
# ---------------------------------------------------------------------------

def load_chain(ticker: str) -> tuple[list[dict], float | None, str]:
    """Opções futuras do ativo, preço à vista e data de referência do cotahist.json."""
    with open(COTAHIST_JSON, encoding="utf-8") as f:
        ch = json.load(f)
    data_ref = ch.get("dataReferencia") or ch.get("data_referencia") or date.today().isoformat()

    def rows(block):
        if isinstance(block, list):
            return block
        if isinstance(block, dict):  # formato colunar do jsonlite
            keys = list(block.keys())
            n = len(block[keys[0]]) if keys else 0
            return [{k: block[k][i] for k in keys} for i in range(n)]
        return []

    spot = None
    for a in rows(ch.get("acoes")):
        if str(a.get("ticker", "")).upper() == ticker:
            spot = float(a["preco"])
            break

    hoje = date.today().isoformat()
    opts = [
        o for o in rows(ch.get("opcoes"))
        if str(o.get("ticker_objeto", "")).upper() == ticker
        and (o.get("vencimento") or "") >= hoje
        and o.get("strike")
    ]
    return opts, spot, data_ref


def load_history(ticker: str) -> pd.Series:
    """Fechamentos diários do COTAHIST anual (ano atual + anterior), via faf."""
    FAF_CACHE.mkdir(parents=True, exist_ok=True)
    year = date.today().year
    # O arquivo do ano corrente cresce a cada pregão: renova o cache após 20h
    cur = FAF_CACHE / f"COTAHIST_A{year}.TXT"
    if cur.exists() and time.time() - cur.stat().st_mtime > 20 * 3600:
        cur.unlink()
    col = CotahistCollector(cache_dir=FAF_CACHE)
    parts = []
    for y in (year - 1, year):  # um ano com falha não derruba o outro
        try:
            df = col.fetch_history(ticker, years=y)
            if not df.empty:
                parts.append(df["Close"])
        except Exception as exc:
            print(f"[options_quant] COTAHIST {y} indisponível: {exc}", file=sys.stderr)
    if not parts:
        return pd.Series(dtype=float)
    s = pd.concat(parts).astype(float).dropna()
    return s[~s.index.duplicated(keep="last")].sort_index()


def load_selic() -> float:
    """Selic em % a.a.: efetiva (série 1178, faf > 0.2.0) ou meta do Copom (432).

    Nunca usa fetch_selic() da faf 0.2.0, que devolvia a taxa DIÁRIA (série 11).
    """
    try:
        from faf.data.collectors.macro_brasil_collector import BCB_SERIES, MacroBrasilCollector
        col = MacroBrasilCollector()
        for alias in ("selic_aa", "selic"):
            if alias not in BCB_SERIES:
                continue
            try:
                val = float(col.fetch(alias, days=40)["value"].dropna().iloc[-1])
            except Exception:
                continue
            if 1 < val < 100:  # descarta taxa diária (~0,05) e lixo
                return val
    except Exception:
        pass
    return SELIC_FALLBACK


# ---------------------------------------------------------------------------
# Cálculo
# ---------------------------------------------------------------------------

def r2(x, nd=2):
    return None if x is None or (isinstance(x, float) and not math.isfinite(x)) else round(float(x), nd)


def business_days(start: date, end: date) -> int:
    hol = b3_holidays(start.year, end.year + 1)
    return int(np.busday_count(start, end, holidays=[d.date() for d in hol]))


def analyze(ticker: str) -> dict:
    opts, spot_cotahist, data_ref = load_chain(ticker)
    if not opts:
        return {"disponivel": False, "motivo": "Sem opções no COTAHIST para este ativo."}

    close = load_history(ticker)
    if len(close) < 40:
        return {"disponivel": False, "motivo": "Histórico insuficiente do ativo-objeto no COTAHIST."}
    close = close.tail(HIST_DAYS)
    spot = spot_cotahist or float(close.iloc[-1])

    selic = load_selic()
    r = math.log(1 + selic / 100)
    rets = np.log(close).diff().dropna()
    rv = float(rets.tail(RV_WINDOW).std() * math.sqrt(252))

    # Regime bayesiano (0 = baixa, 1 = alta)
    regime = None
    try:
        res = BayesianRegimeDetector(n_regimes=2).fit_predict(rets)
        idx = int(res.regimes.iloc[-1])
        regime = {
            "rotulo": "Alta" if idx == 1 else "Baixa",
            "prob": r2(float(res.regime_probs.iloc[-1].max()), 3),
            "pregoes": int(len(rets)),
        }
    except Exception:
        pass

    mc_model = MonteCarloForecast(n_simulations=N_SIMULATIONS, random_state=42).fit(close)
    ref = datetime.strptime(data_ref, "%Y-%m-%d").date()

    vencimentos: dict[str, dict] = {}
    series: dict[str, dict] = {}
    for venc in sorted({o["vencimento"] for o in opts}):
        vdate = datetime.strptime(venc, "%Y-%m-%d").date()
        T = max((vdate - ref).days, 1) / 365
        h = max(business_days(ref, vdate), 1)
        mc = mc_model.forecast(horizon=h)
        term = mc.terminal_prices

        atm_ivs = []
        for o in (x for x in opts if x["vencimento"] == venc):
            K = float(o["strike"])
            typ = "call" if o["tipo"] == "CALL" else "put"
            bid, ask, last = o.get("bid"), o.get("ask"), o.get("preco")
            mid = (bid + ask) / 2 if bid and ask else (last or None)

            iv = None
            if mid and mid > 0:
                try:
                    iv = implied_volatility(mid, spot, K, T, r, typ)
                except Exception:
                    iv = None
            if iv is not None and abs(K - spot) / spot <= ATM_BAND:
                atm_ivs.append(iv)

            delta = black_scholes(spot, K, T, r, iv or rv, typ).delta
            justo = binomial_price(spot, K, T, r, rv, typ, style="american").price
            edge = (mid / justo - 1) * 100 if mid and justo > 0.005 else None
            pex = float(np.mean(term > K)) if typ == "call" else float(np.mean(term < K))

            series[o["ticker"]] = {
                "iv": r2(iv * 100 if iv is not None else None, 1),
                "delta": r2(delta),
                "justo": r2(justo),
                "edgePct": r2(edge, 0),
                "pExerc": r2(pex * 100, 0),
            }

        vencimentos[venc] = {
            "pregoes": h,
            "probAlta": r2(mc.prob_up * 100, 0),
            "p5": r2(np.percentile(term, 5)),
            "p95": r2(np.percentile(term, 95)),
            "ivAtm": r2(float(np.mean(atm_ivs)) * 100, 1) if atm_ivs else None,
        }

    return {
        "disponivel": True,
        "ticker": ticker,
        "dataReferencia": data_ref,
        "spot": r2(spot),
        "selic": r2(selic),
        "rv30": r2(rv * 100, 1),
        "regime": regime,
        "vencimentos": vencimentos,
        "series": series,
        "simulacoes": N_SIMULATIONS,
        "faf": FAF_VERSION,
        "geradoEm": datetime.now().strftime("%d/%m/%Y %H:%M"),
    }


def main() -> None:
    if len(sys.argv) < 2:
        out({"disponivel": False, "motivo": "Ticker não informado"}, 1)
    ticker = sys.argv[1].upper().strip()
    if not COTAHIST_JSON.exists():
        out({"disponivel": False, "motivo": "cotahist.json ainda não gerado."})

    with open(COTAHIST_JSON, encoding="utf-8") as f:
        ch = json.load(f)
    data_ref = ch.get("dataReferencia") or ch.get("data_referencia") or "sem-data"
    cache = QUANT_DIR / f"{ticker}_{data_ref}.json"
    if cache.exists():
        print(cache.read_text(encoding="utf-8"))
        return

    try:
        result = analyze(ticker)
    except Exception as exc:
        out({"disponivel": False, "motivo": f"Falha no cálculo: {type(exc).__name__}: {exc}"})

    if result.get("disponivel"):
        QUANT_DIR.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
        for old in QUANT_DIR.glob("*.json"):  # descarta caches de dias anteriores
            if old != cache and time.time() - old.stat().st_mtime > 7 * 86400:
                old.unlink(missing_ok=True)
    out(result)


if __name__ == "__main__":
    main()
