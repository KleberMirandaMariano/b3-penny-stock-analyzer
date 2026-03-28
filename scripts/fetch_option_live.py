#!/usr/bin/env python3
"""
fetch_option_live.py
====================
Busca dados ao vivo de opções via yfinance (Yahoo Finance, ~15 min delay).
Retorna bid, ask, volume, openInterest e IV para todas as opções do ticker.

Uso:
    python3 scripts/fetch_option_live.py RAIZ4
"""
import sys
import json
import math
import yfinance as yf


def safe_float(val, digits=4):
    try:
        f = float(val)
        return round(f, digits) if not (math.isnan(f) or math.isinf(f)) else None
    except (TypeError, ValueError):
        return None


def safe_int(val):
    try:
        f = float(val)
        return int(f) if not (math.isnan(f) or math.isinf(f)) else None
    except (TypeError, ValueError):
        return None


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Ticker não informado", "opcoes": []}))
        sys.exit(1)

    ticker = sys.argv[1].upper()
    yf_symbol = f"{ticker}.SA"

    try:
        yf_ticker = yf.Ticker(yf_symbol)
        dates = yf_ticker.options
    except Exception as e:
        print(json.dumps({"error": str(e), "opcoes": []}))
        sys.exit(0)

    if not dates:
        print(json.dumps({"fonte": "yfinance", "opcoes": [], "aviso": "Nenhum vencimento disponível no Yahoo Finance para este ticker."}))
        sys.exit(0)

    opcoes = []
    for exp in dates[:8]:
        try:
            chain = yf_ticker.option_chain(exp)
            for _, row in chain.calls.iterrows():
                opcoes.append({
                    "ticker": str(row.get("contractSymbol", "")),
                    "tipo": "CALL",
                    "strike": safe_float(row.get("strike"), 2),
                    "preco": safe_float(row.get("lastPrice"), 2),
                    "bid": safe_float(row.get("bid"), 2),
                    "ask": safe_float(row.get("ask"), 2),
                    "volume": safe_int(row.get("volume")),
                    "openInterest": safe_int(row.get("openInterest")),
                    "impliedVolatility": safe_float(row.get("impliedVolatility"), 4),
                    "vencimento": exp,
                })
            for _, row in chain.puts.iterrows():
                opcoes.append({
                    "ticker": str(row.get("contractSymbol", "")),
                    "tipo": "PUT",
                    "strike": safe_float(row.get("strike"), 2),
                    "preco": safe_float(row.get("lastPrice"), 2),
                    "bid": safe_float(row.get("bid"), 2),
                    "ask": safe_float(row.get("ask"), 2),
                    "volume": safe_int(row.get("volume")),
                    "openInterest": safe_int(row.get("openInterest")),
                    "impliedVolatility": safe_float(row.get("impliedVolatility"), 4),
                    "vencimento": exp,
                })
        except Exception:
            continue

    print(json.dumps({
        "fonte": "yfinance",
        "ticker": ticker,
        "delay": "~15 min durante pregão",
        "opcoes": opcoes,
    }))


if __name__ == "__main__":
    main()
