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
import json
import logging
import math
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

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
# Etapa 1 – Lista de tickers (rb3 R script ou fallback)
# ---------------------------------------------------------------------------

def run_r_script() -> dict | None:
    """Executa o script R e retorna os dados do COTAHIST, ou None se falhar."""
    if not R_SCRIPT.exists():
        log.warning("Script R não encontrado: %s", R_SCRIPT)
        return None

    rscript = subprocess.run(
        ["which", "Rscript"], capture_output=True, text=True
    )
    if rscript.returncode != 0:
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

        return {
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
        }
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


# ---------------------------------------------------------------------------
# Etapa 4 – Persistência
# ---------------------------------------------------------------------------

def save(stocks: list[dict], cotahist: dict | None):
    """Salva o JSON final em public/stocks.json."""
    stocks_sorted = sorted(stocks, key=lambda s: -(s.get("volume") or 0))

    fonte = (
        "rb3 (COTAHIST) + yfinance"
        if cotahist
        else "yfinance (R/rb3 indisponível)"
    )
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

    # 1. Dados COTAHIST via R/rb3
    cotahist = run_r_script()

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

    # 5. Salva
    save(stocks, cotahist)
    log.info("=== Atualização concluída: %d ações ===", len(stocks))


if __name__ == "__main__":
    main()
