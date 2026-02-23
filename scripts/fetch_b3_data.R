#!/usr/bin/env Rscript
suppressPackageStartupMessages({
  library(rb3)
  library(dplyr)
  library(jsonlite)
})

args <- commandArgs(trailingOnly = TRUE)
output_file <- if (length(args) > 0) args[1] else "data/cotahist.json"
max_preco <- as.numeric(Sys.getenv("MAX_PRECO", "15"))

cat("=== rb3 :: Coleta COTAHIST da B3 ===\n")

fetch_cotahist <- function() {
  tryCatch(
    {
      cat("Buscando dados COTAHIST (daily)...\n")
      ch <- cotahist_get("daily")
      if (!is.null(ch) && nrow(ch) > 0) {
        # Tenta descobrir a data no dataset
        date_col <- if ("data_referencia" %in% names(ch)) "data_referencia" else "data_pregao"
        ref_date <- if (date_col %in% names(ch)) max(ch[[date_col]]) else Sys.Date()
        cat(sprintf("Sucesso! %d registros encontrados. Data Ref: %s\n", nrow(ch), as.character(ref_date)))
        return(list(data = ch, date = ref_date))
      }
    },
    error = function(e) {
      cat(sprintf("Erro ao buscar COTAHIST: %s\n", conditionMessage(e)))
    }
  )
  return(NULL)
}

res <- fetch_cotahist()
if (is.null(res)) {
  cat("ERRO: Nenhum dado COTAHIST encontrado nos últimos 30 dias.\n")
  quit(status = 1)
}

ch <- res$data
data_ref <- format(res$date, "%Y-%m-%d")

# Identifica ações e opções
# No rb3, ch costuma ter cod_negociacao, preco_ultimo, etc.
# tipo_mercado: 10 = vista, 70 = call, 80 = put
if (!"tipo_mercado" %in% names(ch)) {
  cat("Aviso: tipo_mercado não encontrado. Tentando inferir.\n")
  # Tenta cotahist_equity_get se falhar o filtro manual
  equity <- tryCatch(cotahist_equity_get(ch), error = function(e) ch)
  options_raw <- ch %>% filter(grepl("[A-Z]{4}[A-L][0-9]+", cod_negociacao) | grepl("[A-Z]{4}[M-X][0-9]+", cod_negociacao))
} else {
  equity <- ch %>% filter(tipo_mercado == 10)
  options_raw <- ch %>% filter(tipo_mercado %in% c(70, 80))
}

cat(sprintf("Ativos Totais: %d | Vista: %d | Opções: %d\n", nrow(ch), nrow(equity), nrow(options_raw)))

# Filtra ações (penny stocks)
penny_stocks <- equity %>%
  mutate(preco = as.numeric(preco_ultimo)) %>%
  filter(!is.na(preco), preco > 0, preco <= max_preco) %>%
  rename(ticker = cod_negociacao)

# Filtra opções dos ativos penny
options_data <- options_raw %>%
  transmute(
    ticker = cod_negociacao,
    ticker_objeto = if ("cod_negociacao_papel_objeto" %in% names(.)) cod_negociacao_papel_objeto else NA_character_,
    preco = as.numeric(preco_ultimo),
    strike = as.numeric(preco_exercicio),
    vencimento = if ("data_vencimento" %in% names(.)) format(data_vencimento, "%Y-%m-%d") else NA_character_,
    tipo = case_when(
      grepl("[A-L][0-9]+$", cod_negociacao) ~ "CALL",
      grepl("[M-X][0-9]+$", cod_negociacao) ~ "PUT",
      TRUE ~ "UNKNOWN"
    )
  )

# Se ticker_objeto faltar, tenta inferir dos primeiros 4 chars
if (all(is.na(options_data$ticker_objeto))) {
  options_data$ticker_objeto <- substr(options_data$ticker, 1, 4)
  # Precisamos casar com o ticker completo da ação (ex: TASA3)
  # Para simplificar, comparamos os 4 primeiros chars
  penny_keys <- substr(penny_stocks$ticker, 1, 4)
  options_data <- options_data %>% filter(ticker_objeto %in% penny_keys)
  # Ajusta ticker_objeto para o ticker real (melhor esforço)
  ticker_map <- setNames(penny_stocks$ticker, substr(penny_stocks$ticker, 1, 4))
  options_data$ticker_objeto <- ticker_map[options_data$ticker_objeto]
} else {
  options_data <- options_data %>% filter(ticker_objeto %in% penny_stocks$ticker)
}

# Exporta JSON
output <- list(
  atualizadoEm = format(Sys.time(), "%d/%m/%Y %H:%M"),
  dataReferencia = data_ref,
  fonte = "rb3",
  acoes = penny_stocks,
  opcoes = options_data %>% filter(!is.na(ticker_objeto))
)

writeLines(toJSON(output, auto_unbox = TRUE, pretty = TRUE), output_file)
cat(sprintf("Arquivo gerado com %d opções para %d ações.\n", nrow(output$opcoes), length(unique(output$opcoes$ticker_objeto))))
