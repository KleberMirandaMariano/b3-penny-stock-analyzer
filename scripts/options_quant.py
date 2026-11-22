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
CACHE_VERSION = "v2"     # muda quando o formato/método do resultado muda


def out(payload: dict, code: int = 0) -> None:
    print(json.dumps(payload, ensure_ascii=False))
    sys.exit(code)


try:
    import numpy as np
    import pandas as pd
    from faf.analysis.bayesian.regime_detection import BayesianRegimeDetector
    from faf.analysis.forecasting import MonteCarloForecast
    from faf.analysis.options import binomial_price, black_scholes, implied_volatility
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


# ---------------------------------------------------------------------------
# Histórico de fechamentos (COTAHIST) — compacto e incremental
# ---------------------------------------------------------------------------
# O COTAHIST anual tem ~90 MB zipado / ~780 MB em texto. Em vez de guardar o
# texto e relê-lo a cada cálculo, o ZIP é lido em streaming uma única vez e só
# os fechamentos do mercado à vista (lote padrão) vão para closes_<ano>.json
# (~2 MB). O ano anterior é baixado uma vez; no ano corrente, depois da carga
# inicial, entram só os arquivos DIÁRIOS novos (~1,4 MB cada).
# Base dos arquivos da B3 (configurável para testes)
B3_SERHIST = os.environ.get("B3_SERHIST_URL", "https://bvmf.bmfbovespa.com.br/InstDados/SerHist/")
CLOSES_DIR = FAF_CACHE / "closes"
MAX_DAILY_GAP = 40  # pregões; acima disso recarrega o anual do ano corrente


def _download(url: str, dest: Path) -> bool:
    """Baixa em streaming; False se a B3 não publicou o arquivo."""
    import requests
    tmp = dest.with_suffix(".part")
    with requests.get(url, stream=True, timeout=60) as r:
        if r.status_code in (403, 404):  # não publicado ou acesso recusado
            return False
        r.raise_for_status()
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
    with open(tmp, "rb") as f:
        is_zip = f.read(2) == b"PK"
    if not is_zip:  # página de erro no lugar do ZIP
        tmp.unlink(missing_ok=True)
        return False
    tmp.replace(dest)
    return True


def _parse_zip(path: Path) -> dict[str, dict[str, float]]:
    """Fechamentos {ticker: {AAAA-MM-DD: preço}} do à vista, lote padrão."""
    import io
    import zipfile
    out_: dict[str, dict[str, float]] = {}
    with zipfile.ZipFile(path) as zf:
        name = next(n for n in zf.namelist() if n.upper().endswith(".TXT"))
        with zf.open(name) as raw:
            for line in io.TextIOWrapper(raw, encoding="latin-1"):
                # TIPREG 01, CODBDI 02 (lote padrão), TPMERC 010 (à vista)
                if line[0:2] != "01" or line[10:12] != "02" or line[24:27] != "010":
                    continue
                fatcot = int(line[210:217] or 1) or 1
                close = int(line[108:121]) / 100.0 / fatcot
                d = line[2:10]
                out_.setdefault(line[12:24].strip(), {})[f"{d[:4]}-{d[4:6]}-{d[6:]}"] = close
    return out_


def _merge(dst: dict, src: dict) -> None:
    for tk, serie in src.items():
        dst.setdefault(tk, {}).update(serie)


def _load_year(year: int) -> dict | None:
    p = CLOSES_DIR / f"closes_{year}.json"
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            return None
    return None


def _save_year(year: int, store: dict) -> None:
    CLOSES_DIR.mkdir(parents=True, exist_ok=True)
    p = CLOSES_DIR / f"closes_{year}.json"
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(store, separators=(",", ":")), encoding="utf-8")
    tmp.replace(p)


def _from_annual(year: int) -> dict | None:
    CLOSES_DIR.mkdir(parents=True, exist_ok=True)
    z = CLOSES_DIR / f"COTAHIST_A{year}.ZIP"
    print(f"[options_quant] baixando COTAHIST anual {year}...", file=sys.stderr)
    if not _download(f"{B3_SERHIST}COTAHIST_A{year}.ZIP", z):
        return None
    try:
        dados = _parse_zip(z)
    finally:
        z.unlink(missing_ok=True)
    ate = max((d for s in dados.values() for d in s), default=f"{year}-01-01")
    return {"ano": year, "ate": ate, "dados": dados}


def _from_monthly(year: int, until_month: int) -> dict | None:
    """Plano B do ano corrente: arquivos mensais dos meses já fechados."""
    dados: dict[str, dict[str, float]] = {}
    for m in range(1, until_month):
        z = CLOSES_DIR / f"COTAHIST_M{m:02d}{year}.ZIP"
        if not _download(f"{B3_SERHIST}COTAHIST_M{m:02d}{year}.ZIP", z):
            return None
        try:
            _merge(dados, _parse_zip(z))
        finally:
            z.unlink(missing_ok=True)
    ate = max((d for s_ in dados.values() for d in s_), default=f"{year - 1}-12-31")
    return {"ano": year, "ate": ate, "dados": dados}


def ensure_year(year: int) -> dict:
    """Garante closes_<ano>.json atualizado e o devolve."""
    today = date.today()
    store = _load_year(year)

    if store is None or (year == today.year and _stale(store, today)):
        fresh = _from_annual(year)
        if fresh is None and year == today.year and today.month > 1:
            fresh = _from_monthly(year, today.month)
        if fresh is not None:
            store = fresh
        elif store is None:
            store = {"ano": year, "ate": f"{year - 1}-12-31", "dados": {}}
        _save_year(year, store)

    if year == today.year:  # incremental com os diários
        hol = {d.date() for d in b3_holidays(year, year)}
        last = datetime.strptime(store["ate"], "%Y-%m-%d").date()
        for d in pd.bdate_range(last + pd.Timedelta(days=1), today):
            d = d.date()
            if d in hol:
                continue
            z = CLOSES_DIR / f"COTAHIST_D{d:%d%m%Y}.ZIP"
            try:
                ok = _download(f"{B3_SERHIST}COTAHIST_D{d:%d%m%Y}.ZIP", z)
            except Exception:
                break
            if not ok:  # ainda não publicado (sai à noite) ou indisponível: tenta depois
                break
            try:
                _merge(store["dados"], _parse_zip(z))
                store["ate"] = d.isoformat()
            finally:
                z.unlink(missing_ok=True)
        _save_year(year, store)
    return store


def _stale(store: dict, today: date) -> bool:
    last = datetime.strptime(store["ate"], "%Y-%m-%d").date()
    return int(np.busday_count(last, today)) > MAX_DAILY_GAP


def prepare_history() -> dict:
    """Prepara (ou atualiza) os dois anos; usado no pré-aquecimento."""
    import fcntl
    CLOSES_DIR.mkdir(parents=True, exist_ok=True)
    # Remove o cache antigo do coletor do faf (TXT anual de ~780 MB)
    for big in FAF_CACHE.glob("COTAHIST_A*.TXT"):
        big.unlink(missing_ok=True)
    with open(CLOSES_DIR / ".lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)  # um preparo por vez
        year = date.today().year
        return {y: ensure_year(y) for y in (year - 1, year)}


def load_history(ticker: str) -> pd.Series:
    """Fechamentos diários do ativo (ano anterior + corrente)."""
    stores = prepare_history()
    serie: dict[str, float] = {}
    for st in stores.values():
        serie.update(st["dados"].get(ticker, {}))
    if not serie:
        return pd.Series(dtype=float)
    s = pd.Series(serie, dtype=float)
    s.index = pd.to_datetime(s.index)
    return s.sort_index()


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


# ---------------------------------------------------------------------------
# Volatilidade: realizada (várias janelas), robusta e prevista
# ---------------------------------------------------------------------------
EWMA_LAMBDA = 0.94      # RiskMetrics
ROBUST_CLIP = 3.0       # winsorização em ±3 desvios robustos


def _ann(x: float) -> float:
    return float(x) * math.sqrt(252)


def realized_vols(rets: pd.Series) -> dict:
    """Realizada 10/30/60d, realizada robusta 30d e o maior movimento da janela de 30d."""
    out_ = {f"rv{n}": r2(_ann(rets.tail(n).std()) * 100, 1) for n in (10, 30, 60) if len(rets) >= n}
    w = rets.tail(RV_WINDOW)
    med = float(w.median())
    sigma_rob = 1.4826 * float((w - med).abs().median())  # desvio via MAD
    if sigma_rob > 0:
        clipped = w.clip(med - ROBUST_CLIP * sigma_rob, med + ROBUST_CLIP * sigma_rob)
        out_["rvRobusta30"] = r2(_ann(clipped.std()) * 100, 1)
    big = w.abs().idxmax()
    out_["maiorMov"] = {"data": big.strftime("%Y-%m-%d"), "pct": r2(math.expm1(float(w[big])) * 100, 1)}
    # Evento: o maior movimento passa de 3 desvios robustos
    out_["evento"] = bool(sigma_rob > 0 and abs(float(w[big]) - med) > ROBUST_CLIP * sigma_rob)
    return out_


def ewma_vol(rets: pd.Series) -> float:
    """Volatilidade EWMA diária (λ = 0,94): choques antigos perdem peso a cada dia."""
    var = float(rets.head(20).var())
    for x in rets.to_numpy():
        var = EWMA_LAMBDA * var + (1 - EWMA_LAMBDA) * float(x) ** 2
    return math.sqrt(var)


def forecast_vol_path(rets: pd.Series, horizon: int) -> tuple[np.ndarray, str]:
    """Vol diária prevista para cada dia até ``horizon`` (GARCH(1,1) do faf; EWMA de reserva)."""
    ew = ewma_vol(rets)
    try:
        from faf.analysis.timeseries.garch import GARCHModel
        g = GARCHModel(p=1, q=1, model="GARCH", dist="t", periods_per_year=252, random_state=42).fit(rets)
        path = np.asarray(g.forecast(n_periods=horizon).forecast_vol, dtype=float)
        ref = float(rets.tail(60).std())
        # Sanidade: GARCH não convergido ou fora de 0,3×–3× a realizada 60d → EWMA
        if g.converged and np.all(np.isfinite(path)) and 0.3 * ref < path.mean() < 3 * ref:
            return path, "GARCH(1,1)"
    except Exception as exc:
        print(f"[options_quant] GARCH indisponível ({type(exc).__name__}): usando EWMA", file=sys.stderr)
    return np.full(horizon, ew), "EWMA"


def rescale_to_vol(close: pd.Series, sigma_daily: float) -> pd.Series:
    """Mesma série com os log-retornos reescalados para a vol desejada.

    Mantém a deriva, a forma da distribuição e o último preço; serve para o
    Monte Carlo do faf simular com a vol PREVISTA em vez da histórica.
    """
    lr = np.log(close).diff().dropna()
    mu, sd = float(lr.mean()), float(lr.std())
    if sd <= 0:
        return close
    adj = mu + (lr - mu) * (sigma_daily / sd)
    cum = adj.cumsum()
    path = float(close.iloc[-1]) * np.exp(cum - cum.iloc[-1])
    first = pd.Series([float(path.iloc[0]) / math.exp(float(adj.iloc[0]))], index=close.index[:1])
    return pd.concat([first, path])


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
    vols = realized_vols(rets)
    vols["ewma"] = r2(_ann(ewma_vol(rets)) * 100, 1)

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

    ref = datetime.strptime(data_ref, "%Y-%m-%d").date()
    vencs = sorted({o["vencimento"] for o in opts})
    h_max = max(max(business_days(ref, datetime.strptime(v, "%Y-%m-%d").date()), 1) for v in vencs)
    vol_path, vol_metodo = forecast_vol_path(rets, h_max)
    vols["metodoPrev"] = vol_metodo

    vencimentos: dict[str, dict] = {}
    series: dict[str, dict] = {}
    for venc in vencs:
        vdate = datetime.strptime(venc, "%Y-%m-%d").date()
        T = max((vdate - ref).days, 1) / 365
        h = max(business_days(ref, vdate), 1)
        # Vol prevista média até o vencimento (variância média do caminho)
        sig_d = float(np.sqrt(np.mean(vol_path[:h] ** 2)))
        vol_prev = _ann(sig_d)
        # Monte Carlo do faf com os retornos reescalados para a vol prevista
        mc = MonteCarloForecast(n_simulations=N_SIMULATIONS, random_state=42).fit(
            rescale_to_vol(close, sig_d)
        ).forecast(horizon=h)
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

            delta = black_scholes(spot, K, T, r, iv or vol_prev, typ).delta
            justo = binomial_price(spot, K, T, r, vol_prev, typ, style="american").price
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
            "volPrev": r2(vol_prev * 100, 1),
        }

    return {
        "disponivel": True,
        "ticker": ticker,
        "dataReferencia": data_ref,
        "spot": r2(spot),
        "selic": r2(selic),
        "rv30": r2(rv * 100, 1),
        "vol": vols,
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
    if sys.argv[1] == "--prewarm":
        stores = prepare_history()
        out({"ok": True, "anos": {str(y): {"ate": st["ate"], "ativos": len(st["dados"])} for y, st in stores.items()}})
    ticker = sys.argv[1].upper().strip()
    if not COTAHIST_JSON.exists():
        out({"disponivel": False, "motivo": "cotahist.json ainda não gerado."})

    with open(COTAHIST_JSON, encoding="utf-8") as f:
        ch = json.load(f)
    data_ref = ch.get("dataReferencia") or ch.get("data_referencia") or "sem-data"
    cache = QUANT_DIR / f"{ticker}_{data_ref}_{CACHE_VERSION}.json"
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
