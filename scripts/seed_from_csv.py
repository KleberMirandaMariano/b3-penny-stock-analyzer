#!/usr/bin/env python3
"""
seed_from_csv.py
================
Converte o CSV estático embutido (src/data.ts) para public/stocks.json.
Útil como ponto de partida ou em ambientes sem acesso à internet.

Uso: python3 scripts/seed_from_csv.py
"""
import json
import re
import math
from datetime import datetime
from pathlib import Path

ROOT_DIR   = Path(__file__).resolve().parent.parent
DATA_TS    = ROOT_DIR / "src" / "data.ts"
OUTPUT_JSON = ROOT_DIR / "public" / "stocks.json"

def parse_currency(val: str) -> float | None:
    if not val or val.strip() == "":
        return None
    cleaned = val.replace("R$", "").replace(".", "").replace(",", ".").strip()
    try:
        return float(cleaned)
    except ValueError:
        return None

def parse_pct(val: str) -> float | None:
    if not val or val.strip() == "":
        return None
    cleaned = val.replace("%", "").replace("+", "").replace(",", ".").strip()
    try:
        f = float(cleaned)
        return None if math.isnan(f) else f
    except ValueError:
        return None

def parse_num(val: str) -> float | None:
    if not val or val.strip() == "":
        return None
    cleaned = val.replace(".", "").replace(",", ".").strip()
    try:
        return float(cleaned)
    except ValueError:
        return None

def extract_csv(ts_file: Path) -> str:
    content = ts_file.read_text(encoding="utf-8")
    # Extract content between backticks
    m = re.search(r'RAW_STOCK_DATA\s*=\s*`([^`]+)`', content, re.DOTALL)
    if not m:
        raise ValueError("CSV não encontrado em data.ts")
    return m.group(1).strip()

def parse_csv(csv_text: str) -> list[dict]:
    lines = csv_text.splitlines()
    if not lines:
        return []

    header = [h.strip() for h in lines[0].split(",")]
    stocks = []

    for line in lines[1:]:
        if not line.strip():
            continue

        # Parse CSV respeitando campos entre aspas
        fields = []
        buf = ""
        in_quotes = False
        for ch in line:
            if ch == '"':
                in_quotes = not in_quotes
            elif ch == "," and not in_quotes:
                fields.append(buf.strip().strip('"'))
                buf = ""
            else:
                buf += ch
        fields.append(buf.strip().strip('"'))

        if len(fields) < len(header):
            fields += [""] * (len(header) - len(fields))

        row = dict(zip(header, fields))
        ticker  = row.get("Ticker", "").strip()
        empresa = row.get("Empresa", "").strip()
        if not ticker or not empresa:
            continue

        preco = parse_currency(row.get("Preço Atual (R$)", ""))
        if preco is None:
            continue

        # Graham upside: reusa o campo já calculado (se disponível)
        upside_str = row.get("Upside Graham (%)", "")
        upside = parse_pct(upside_str)

        stocks.append({
            "ticker":            ticker,
            "empresa":           empresa,
            "preco":             round(preco, 2),
            "setor":             row.get("Setor", "N/A").strip() or "N/A",
            "dy":                parse_pct(row.get("Dividend Yield (%)", "")),
            "pl":                parse_num(row.get("P/L", "")),
            "pvp":               parse_num(row.get("P/VP", "")),
            "var5a":             parse_pct(row.get("Variação 5 Anos (%)", "")),
            "upsideGraham":      upside,
            "varDia":            parse_pct(row.get("Var. Dia (%)", "")),
            "varSemana":         parse_pct(row.get("Var. Semana (%)", "")),
            "volume":            int(parse_num(row.get("Volume", "") or "") or 0) or None,
            "ultimaAtualizacao": row.get("Última Atualização", "").strip(),
        })

    return stocks

def main():
    OUTPUT_JSON.parent.mkdir(parents=True, exist_ok=True)

    print(f"Lendo CSV de {DATA_TS} ...")
    csv_text = extract_csv(DATA_TS)
    stocks   = parse_csv(csv_text)
    print(f"Ações parseadas: {len(stocks)}")

    now_str = datetime.now().strftime("%d/%m/%Y %H:%M")
    output  = {
        "atualizadoEm":   now_str,
        "dataReferencia": "",
        "fonte":          "CSV estático (src/data.ts)",
        "totalAcoes":     len(stocks),
        "acoes":          stocks,
    }

    with open(OUTPUT_JSON, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"Salvo: {OUTPUT_JSON}")

if __name__ == "__main__":
    main()
