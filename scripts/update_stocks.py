#!/usr/bin/env python3
"""
update_stocks.py
================
Atualiza os dados de ações da B3 (penny stocks < R$10).

Fluxo:
  1. Tenta executar o script R (rb3/COTAHIST) para obter lista completa de tickers
  2. Se R não disponível, usa base_tickers.json + stocks.json existente
  3. Busca dados fundamentalistas via yfinance (.SA suffix)
  4. Calcula Graham Upside, variações e indicadores
  5. Salva em public/stocks.json (consumido pela API Express e pelo Vite)

Uso:
  python3 scripts/update_stocks.py [--max-preco 10.0] [--workers 8]
"""

import argparse
import io
import json
import logging
import math
import os
import subprocess
import sys
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
import yfinance as yf

# ---------------------------------------------------------------------------
# Configuração
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("update_stocks")

ROOT_DIR       = Path(__file__).resolve().parent.parent
SCRIPTS_DIR    = ROOT_DIR / "scripts"
DATA_DIR       = ROOT_DIR / "data"
PUBLIC_DIR     = ROOT_DIR / "public"
R_SCRIPT       = SCRIPTS_DIR / "fetch_b3_data.R"
COTAHIST_JSON  = DATA_DIR / "cotahist.json"
BASE_TICKERS   = SCRIPTS_DIR / "base_tickers.json"
OUTPUT_JSON    = PUBLIC_DIR / "stocks.json"

SECTOR_MAP = {
    "Basic Materials":        "Materiais Básicos",
    "Communication Services": "Comunicação",
    "Consumer Cyclical":      "Consumo Cíclico",
    "Consumer Defensive":     "Consumo Não Cíclico",
    "Energy":                 "Energia",
    "Financial Services":     "Serviços Financeiros",
    "Healthcare":             "Saúde",
    "Industrials":            "Bens Industriais",
    "Real Estate":            "Construção e Imobiliário",
    "Technology":             "Tecnologia",
    "Utilities":              "Energia",
}

# ---------------------------------------------------------------------------
# Utilitários
# ---------------------------------------------------------------------------

def ensure_dirs():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    PUBLIC_DIR.mkdir(parents=True, exist_ok=True)


def _safe_round(val, digits=2):
    try:
        f = float(val)
        return None if math.isnan(f) or math.isinf(f) else round(f, digits)
    except (TypeError, ValueError):
        return None


def _safe_int(val):
    try:
        return int(val) if val and not math.isnan(float(val)) else None
    except (TypeError, ValueError):
        return None


def map_sector(yf_sector: str) -> str:
    return SECTOR_MAP.get(yf_sector or "", yf_sector or "N/A")


def graham_upside(eps, bvps, price) -> float | None:
    """Upside pelo Número de Graham: sqrt(22.5 × LPA × VPA)"""
    if eps and bvps and price and eps > 0 and bvps > 0 and price > 0:
        graham = math.sqrt(22.5 * eps * bvps)
        return _safe_round(((graham / price) - 1) * 100)
    return None


# ---------------------------------------------------------------------------
# COTAHIST em Python (fallback quando R/rb3 não está disponível)
# ---------------------------------------------------------------------------

def _parse_cotahist_line(line: str) -> dict | None:
    """Parseia uma linha do arquivo COTAHIST (layout fixo B3)."""
    if len(line) < 245:
        return None
    tipreg = line[0:2]
    if tipreg != "01":
        return None

    tpmerc = line[24:27].strip()
    if tpmerc not in ("010", "070", "080"):
        return None

    codneg = line[12:24].strip()
    preult = int(line[108:121]) / 100.0
    volume = int(line[170:188]) / 100.0

    rec = {
        "codneg": codneg,
        "tpmerc": tpmerc,
        "preult": preult,
        "volume": volume,
    }

    if tpmerc in ("070", "080"):
        preexe = int(line[188:201]) / 100.0
        datven_raw = line[202:210].strip()
        try:
            datven = datetime.strptime(datven_raw, "%Y%m%d").strftime("%Y-%m-%d")
        except ValueError:
            datven = None
        rec["preexe"] = preexe
        rec["datven"] = datven
        rec["tipo"] = "CALL" if tpmerc == "070" else "PUT"

    return rec


def _download_cotahist_daily(target_date: datetime | None = None) -> str | None:
    """
    Baixa o arquivo COTAHIST diário da B3.
    Tenta os últimos 5 dias úteis caso o dia solicitado não esteja disponível.
    """
    if target_date is None:
        target_date = datetime.now()

    urls_tried = []
    for delta in range(6):
        d = target_date - timedelta(days=delta)
        # Pula fins de semana
        if d.weekday() >= 5:
            continue

        date_str = d.strftime("%d%m%Y")
        url = f"https://bvmf.bmfbovespa.com.br/InstDados/SerHist/COTAHIST_D{date_str}.ZIP"
        urls_tried.append(url)

        try:
            log.info("Tentando baixar COTAHIST: %s", url)
            resp = requests.get(url, timeout=30)
            if resp.status_code == 200 and len(resp.content) > 500:
                with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
                    names = zf.namelist()
                    if not names:
                        continue
                    content = zf.read(names[0]).decode("latin-1")
                    log.info("COTAHIST baixado: %s (%d bytes)", d.strftime("%Y-%m-%d"), len(content))
                    return content
        except Exception as exc:
            log.debug("Falha ao baixar %s: %s", url, exc)

    log.warning("Não foi possível baixar COTAHIST de nenhuma data recente. URLs tentadas: %s", urls_tried)
    return None


def fetch_cotahist_python(max_preco: float = 15.0) -> dict | None:
    """
    Substituto Python puro do script R (rb3).
    Baixa e parseia o COTAHIST diário da B3, retornando ações e opções.
    """
    raw = _download_cotahist_daily()
    if not raw:
        return None

    acoes = []
    opcoes = []
    data_ref = None

    for line in raw.splitlines():
        if len(line) < 245:
            continue

        rec = _parse_cotahist_line(line)
        if not rec:
            continue

        # Extrai data de referência da primeira linha de dados
        if data_ref is None:
            try:
                data_ref = datetime.strptime(line[2:10], "%Y%m%d").strftime("%Y-%m-%d")
            except ValueError:
                pass

        if rec["tpmerc"] == "010":
            # Ação à vista
            if 0 < rec["preult"] <= max_preco:
                acoes.append({
                    "ticker": rec["codneg"],
                    "preco": rec["preult"],
                    "volume": rec["volume"],
                })
        elif rec["tpmerc"] in ("070", "080"):
            # Inferir ticker_objeto: primeiros 4 chars + número (ex: TASA3 → TASA)
            base = rec["codneg"][:4]
            opcoes.append({
                "ticker": rec["codneg"],
                "ticker_objeto": base,
                "tipo": rec["tipo"],
                "preco": rec["preult"],
                "strike": rec["preexe"],
                "vencimento": rec["datven"],
            })

    if not acoes:
        log.warning("COTAHIST Python: nenhuma ação encontrada.")
        return None

    # Casar ticker_objeto com tickers reais das ações (pode haver múltiplos: TASA3, TASA4)
    prefix_to_tickers: dict[str, list[str]] = {}
    for a in acoes:
        prefix = a["ticker"][:4]
        if prefix not in prefix_to_tickers:
            prefix_to_tickers[prefix] = []
        if a["ticker"] not in prefix_to_tickers[prefix]:
            prefix_to_tickers[prefix].append(a["ticker"])

    opcoes_filtradas = []
    for o in opcoes:
        tickers_reais = prefix_to_tickers.get(o["ticker_objeto"], [])
        for real_ticker in tickers_reais:
            opcoes_filtradas.append({
                **o,
                "ticker_objeto": real_ticker,
            })

    if not data_ref:
        data_ref = datetime.now().strftime("%Y-%m-%d")

    result = {
        "atualizadoEm": datetime.now().strftime("%d/%m/%Y %H:%M"),
        "data_referencia": data_ref,
        "fonte": "cotahist-python",
        "total": len(acoes),
        "acoes": acoes,
        "opcoes": opcoes_filtradas,
    }

    # Salva em cache para uso posterior
    try:
        COTAHIST_JSON.parent.mkdir(parents=True, exist_ok=True)
        with open(COTAHIST_JSON, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
        log.info("COTAHIST Python salvo: %d ações, %d opções", len(acoes), len(opcoes_filtradas))
    except Exception as exc:
        log.warning("Erro ao salvar COTAHIST JSON: %s", exc)

    return result


# ---------------------------------------------------------------------------
# Etapa 1 – Lista de tickers (rb3 R script ou fallback Python)
# ---------------------------------------------------------------------------

def run_r_script() -> dict | None:
    """Executa o script R e retorna os dados do COTAHIST, ou None se falhar."""
    if not R_SCRIPT.exists():
        log.warning("Script R não encontrado: %s", R_SCRIPT)
        return None

    cmd = "where" if os.name == "nt" else "which"
    rscript_check = subprocess.run(
        [cmd, "Rscript"], capture_output=True, text=True
    )
    if rscript_check.returncode != 0:
        log.warning("Rscript não encontrado no PATH. Usando fallback yfinance.")
        return None

    log.info("Executando script R (rb3/COTAHIST)...")
    env = {**os.environ, "MAX_PRECO": "15"}  # margem para capturar mais tickers
    proc = subprocess.run(
        ["Rscript", str(R_SCRIPT), str(COTAHIST_JSON)],
        capture_output=True,
        text=True,
        cwd=str(ROOT_DIR),
        env=env,
    )
    if proc.stdout:
        for line in proc.stdout.strip().splitlines():
            log.info("R | %s", line)
    if proc.returncode != 0:
        log.error("Falha no script R:\n%s", proc.stderr)
        return None

    try:
        with open(COTAHIST_JSON, encoding="utf-8") as f:
            data = json.load(f)
        log.info("COTAHIST carregado: %d ativos", data.get("total", 0))
        return data
    except Exception as exc:
        log.error("Erro ao ler COTAHIST JSON: %s", exc)
        return None


def get_ticker_list(cotahist: dict | None, max_preco: float) -> list[str]:
    """
    Constrói a lista de tickers a monitorar.
    Prioridade: COTAHIST (rb3) > stocks.json existente > base_tickers.json
    """
    tickers: set[str] = set()

    # 1. Tickers do COTAHIST (rb3) – mais completo
    if cotahist:
        acoes = cotahist.get("acoes", [])
        if isinstance(acoes, list):
            for row in acoes:
                t = row.get("ticker", "")
                if t:
                    tickers.add(t.strip().upper())
        elif isinstance(acoes, dict):
            # Formato colunar (R as.data.frame → jsonlite)
            for t in acoes.get("ticker", []):
                if t:
                    tickers.add(str(t).strip().upper())
        log.info("Tickers do COTAHIST: %d", len(tickers))

    # 2. Tickers do arquivo de saída existente (atualização incremental)
    if OUTPUT_JSON.exists():
        try:
            with open(OUTPUT_JSON, encoding="utf-8") as f:
                existing = json.load(f)
            for stock in existing.get("acoes", []):
                t = stock.get("ticker", "")
                if t:
                    tickers.add(t.strip().upper())
            log.info("Tickers do stocks.json existente: %d total", len(tickers))
        except Exception:
            pass

    # 3. Lista base (sempre incluída)
    if BASE_TICKERS.exists():
        with open(BASE_TICKERS, encoding="utf-8") as f:
            base = json.load(f)
        for t in base.get("tickers", []):
            tickers.add(t.strip().upper())

    return sorted(tickers)


# ---------------------------------------------------------------------------
# Etapa 2 – Dados fundamentalistas via yfinance
# ---------------------------------------------------------------------------

def fetch_stock(ticker: str, max_preco: float) -> dict | None:
    """
    Busca dados de um único ticker no Yahoo Finance.
    Retorna dict padronizado ou None se o ativo não atender aos critérios.
    """
    yf_symbol = f"{ticker}.SA"
    try:
        yf_ticker = yf.Ticker(yf_symbol)
        info = yf_ticker.info or {}

        price = (
            info.get("currentPrice")
            or info.get("regularMarketPrice")
            or info.get("previousClose")
        )
        if not price or price <= 0 or price > max_preco:
            return None

        # Variações
        prev_close = info.get("previousClose") or info.get("regularMarketPreviousClose")
        var_dia = _safe_round(((price / prev_close) - 1) * 100) if prev_close else None

        hist_week = yf_ticker.history(period="5d", auto_adjust=True)
        var_semana = None
        if len(hist_week) >= 2:
            var_semana = _safe_round(
                ((hist_week["Close"].iloc[-1] / hist_week["Close"].iloc[0]) - 1) * 100
            )

        hist_5y = yf_ticker.history(period="5y", auto_adjust=True)
        var5a = None
        if len(hist_5y) >= 2:
            var5a = _safe_round(
                ((hist_5y["Close"].iloc[-1] / hist_5y["Close"].iloc[0]) - 1) * 100
            )

        # Fundamentalistas
        eps   = info.get("trailingEps") or info.get("forwardEps")
        bvps  = info.get("bookValue")
        pl    = _safe_round(info.get("trailingPE"))
        pvp   = None
        if price and bvps and bvps != 0:
            pvp = _safe_round(price / bvps)

        dy = None
        raw_dy = info.get("dividendYield")
        if raw_dy:
            dy = _safe_round(raw_dy * 100)

        upside = graham_upside(eps, bvps, price)

        nome = (
            info.get("shortName")
            or info.get("longName")
            or ticker
        )

        now_str = datetime.now(tz=timezone.utc).astimezone().strftime("%d/%m/%Y %H:%M")

        data = {
            "ticker":           ticker,
            "empresa":          nome,
            "preco":            _safe_round(price),
            "setor":            map_sector(info.get("sector", "")),
            "dy":               dy,
            "pl":               pl,
            "pvp":              pvp,
            "var5a":            var5a,
            "upsideGraham":     upside,
            "varDia":           var_dia,
            "varSemana":        var_semana,
            "volume":           _safe_int(info.get("volume") or info.get("regularMarketVolume")),
            "ultimaAtualizacao": now_str,
            "opcoes":           [] 
        }

        # --- Busca opções via yfinance (opicional/fallback) ---
        try:
            options_dates = yf_ticker.options
            if options_dates:
                next_expiry = options_dates[0]
                chain = yf_ticker.option_chain(next_expiry)
                
                opcoes_yf = []
                for _, row in chain.calls.iterrows():
                    opcoes_yf.append({
                        "ticker": row["contractSymbol"],
                        "tipo": "CALL",
                        "strike": _safe_round(row["strike"]),
                        "preco": _safe_round(row["lastPrice"]),
                        "vencimento": next_expiry
                    })
                for _, row in chain.puts.iterrows():
                    opcoes_yf.append({
                        "ticker": row["contractSymbol"],
                        "tipo": "PUT",
                        "strike": _safe_round(row["strike"]),
                        "preco": _safe_round(row["lastPrice"]),
                        "vencimento": next_expiry
                    })
                
                # Limita a 10 opções (5 mais próximas do preço atual)
                price_current = price
                calls_sorted = sorted([o for o in opcoes_yf if o["tipo"] == "CALL"], 
                                      key=lambda x: abs((x["strike"] or 0) - price_current))[:5]
                puts_sorted = sorted([o for o in opcoes_yf if o["tipo"] == "PUT"], 
                                     key=lambda x: abs((x["strike"] or 0) - price_current))[:5]
                
                data["opcoes_yf"] = sorted(calls_sorted + puts_sorted, key=lambda x: x["strike"] or 0)
        except Exception as opt_exc:
            log.debug("Erro ao buscar opções para %s: %s", ticker, opt_exc)

        return data
    except Exception as exc:
        log.debug("Erro em %s: %s", ticker, exc)
        return None


def fetch_all(tickers: list[str], max_preco: float, workers: int) -> list[dict]:
    """Busca dados de todos os tickers em paralelo."""
    results: list[dict] = []
    total = len(tickers)
    done  = 0

    log.info("Buscando dados de %d tickers (workers=%d)...", total, workers)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(fetch_stock, t, max_preco): t for t in tickers}
        for fut in as_completed(futures):
            done += 1
            ticker = futures[fut]
            data = fut.result()
            if data:
                results.append(data)
                log.debug("[%d/%d] %s  R$ %.2f", done, total, ticker, data["preco"])
            else:
                log.debug("[%d/%d] %s  ignorado", done, total, ticker)
            if done % 10 == 0 or done == total:
                log.info("Progresso: %d/%d  (aceitas: %d)", done, total, len(results))

    return results


# ---------------------------------------------------------------------------
# Etapa 3 – Enriquecer com dados do COTAHIST quando disponível
# ---------------------------------------------------------------------------

def enrich_with_cotahist(stocks: list[dict], cotahist: dict | None) -> list[dict]:
    """
    Sobrescreve preço e volume dos dados yfinance com os dados oficiais do
    COTAHIST (rb3), quando disponíveis, por ser fonte mais confiável.
    """
    if not cotahist:
        return stocks

    acoes_raw = cotahist.get("acoes", {})
    # Constrói índice ticker → linha do COTAHIST
    cotahist_index: dict[str, dict] = {}

    if isinstance(acoes_raw, list):
        for row in acoes_raw:
            t = str(row.get("ticker", "")).strip().upper()
            if t:
                cotahist_index[t] = row
    elif isinstance(acoes_raw, dict):
        # Formato colunar
        tickers_col  = acoes_raw.get("ticker", [])
        precos_col   = acoes_raw.get("preco", [])
        volumes_col  = acoes_raw.get("volume", [])
        var_dia_col  = acoes_raw.get("var_dia_pct", [])
        for i, t in enumerate(tickers_col):
            t = str(t).strip().upper()
            cotahist_index[t] = {
                "preco":       precos_col[i]  if i < len(precos_col)  else None,
                "volume":      volumes_col[i] if i < len(volumes_col) else None,
                "var_dia_pct": var_dia_col[i] if i < len(var_dia_col) else None,
            }

    enriched = 0
    for stock in stocks:
        row = cotahist_index.get(stock["ticker"])
        if row:
            if row.get("preco"):
                stock["preco"]  = _safe_round(row["preco"])
            if row.get("volume"):
                stock["volume"] = _safe_int(row["volume"])
            if row.get("var_dia_pct") is not None:
                stock["varDia"] = _safe_round(row["var_dia_pct"])
            enriched += 1

    log.info("Enriquecidos com COTAHIST: %d ações", enriched)
    return stocks


def enrich_with_options(stocks: list[dict], cotahist: dict | None) -> list[dict]:
    """
    Agrupa as opções por ticker_objeto e anexa ao dicionário da ação correspondente.
    Filtra pelo próximo vencimento disponível.
    """
    if not cotahist or "opcoes" not in cotahist:
        # Sem COTAHIST – usa opções do yfinance se existirem
        for s in stocks:
            opcoes_yf = s.pop("opcoes_yf", [])
            s["opcoes"] = sorted(opcoes_yf, key=lambda x: x["strike"] or 0) if opcoes_yf else []
        yf_count = sum(1 for s in stocks if s["opcoes"])
        if yf_count:
            log.info("Opções yfinance vinculadas a %d ações (sem COTAHIST)", yf_count)
        return stocks

    opcoes_raw = cotahist["opcoes"]
    opcoes_data = []

    if isinstance(opcoes_raw, list):
        opcoes_data = opcoes_raw
    elif isinstance(opcoes_raw, dict):
        # Formato colunar jsonlite
        keys = opcoes_raw.keys()
        count = len(next(iter(opcoes_raw.values())))
        for i in range(count):
            opcoes_data.append({k: opcoes_raw[k][i] for k in keys})

    if not opcoes_data:
        for s in stocks:
            s["opcoes"] = []
        return stocks

    hoje = datetime.now().strftime("%Y-%m-%d")

    # Agrupar todas as opções futuras por ticker_objeto
    mapa_todas: dict[str, list] = {}
    for o in opcoes_data:
        venc = o.get("vencimento")
        if not venc or venc < hoje:
            continue

        tik_obj = str(o["ticker_objeto"]).strip().upper()
        if tik_obj not in mapa_todas:
            mapa_todas[tik_obj] = []

        mapa_todas[tik_obj].append({
            "ticker": o["ticker"],
            "tipo": o["tipo"],
            "strike": _safe_round(o["strike"]),
            "preco": _safe_round(o["preco"]),
            "vencimento": venc,
        })

    # Para cada ação, seleciona opções do próximo vencimento por tipo (CALL e PUT separados)
    mapa_opcoes: dict[str, list] = {}
    for tik_obj, opts in mapa_todas.items():
        selected = []
        for tipo in ("CALL", "PUT"):
            tipo_opts = [o for o in opts if o["tipo"] == tipo]
            if not tipo_opts:
                continue
            vencimentos = sorted(set(o["vencimento"] for o in tipo_opts))
            proximo = vencimentos[0]
            selected.extend(o for o in tipo_opts if o["vencimento"] == proximo)
        if selected:
            mapa_opcoes[tik_obj] = selected

    for s in stocks:
        tik = s["ticker"].upper()
        # Prioridade: COTAHIST > yfinance > Vazio
        opcoes_rb3 = mapa_opcoes.get(tik, [])
        opcoes_yf = s.pop("opcoes_yf", [])

        if opcoes_rb3:
            s["opcoes"] = sorted(opcoes_rb3, key=lambda x: x["strike"] or 0)
        else:
            s["opcoes"] = sorted(opcoes_yf, key=lambda x: x["strike"] or 0)

    log.info("Opções vinculadas a %d ações", len(mapa_opcoes))
    return stocks


# ---------------------------------------------------------------------------
# Etapa 4 – Persistência
# ---------------------------------------------------------------------------

def save(stocks: list[dict], cotahist: dict | None):
    """Salva o JSON final em public/stocks.json."""
    stocks_sorted = sorted(stocks, key=lambda s: -(s.get("volume") or 0))

    if cotahist:
        src = cotahist.get("fonte", "cotahist")
        fonte = f"{src} + yfinance"
    else:
        fonte = "yfinance (COTAHIST indisponível)"
    ref_date = (
        cotahist.get("data_referencia", "")
        if cotahist
        else datetime.now().strftime("%Y-%m-%d")
    )

    output = {
        "atualizadoEm":   datetime.now().strftime("%d/%m/%Y %H:%M"),
        "dataReferencia": ref_date,
        "fonte":          fonte,
        "totalAcoes":     len(stocks_sorted),
        "acoes":          stocks_sorted,
    }

    with open(OUTPUT_JSON, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    log.info("Salvo: %s (%d ações)", OUTPUT_JSON, len(stocks_sorted))


# ---------------------------------------------------------------------------
# Entry-point
# ---------------------------------------------------------------------------

def parse_args():
    p = argparse.ArgumentParser(description="Atualiza dados de penny stocks da B3")
    p.add_argument("--max-preco", type=float, default=10.0,
                   help="Preço máximo para filtro (padrão: 10.0)")
    p.add_argument("--workers", type=int, default=8,
                   help="Threads paralelas para yfinance (padrão: 8)")
    return p.parse_args()


def main():
    args = parse_args()
    ensure_dirs()

    log.info("=== Iniciando atualização de dados B3 ===")
    log.info("Filtro: preço ≤ R$ %.2f | workers: %d", args.max_preco, args.workers)

    # 1. Dados COTAHIST via R/rb3 (primário) ou Python (fallback)
    cotahist = run_r_script()
    if not cotahist:
        log.info("Tentando fallback: COTAHIST via Python...")
        cotahist = fetch_cotahist_python(max_preco=args.max_preco + 5)

    # 2. Lista de tickers
    tickers = get_ticker_list(cotahist, args.max_preco)
    log.info("Total de tickers a verificar: %d", len(tickers))

    # 3. Busca yfinance
    stocks = fetch_all(tickers, args.max_preco, args.workers)

    if not stocks:
        log.error("Nenhuma ação encontrada. Verifique conectividade e parâmetros.")
        sys.exit(1)

    # 4. Enriquece com COTAHIST
    stocks = enrich_with_cotahist(stocks, cotahist)

    # 4.1 Vincula opções
    stocks = enrich_with_options(stocks, cotahist)

    # 5. Salva
    save(stocks, cotahist)
    log.info("=== Atualização concluída: %d ações ===", len(stocks))


if __name__ == "__main__":
    main()
