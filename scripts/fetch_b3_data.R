#!/usr/bin/env Rscript
# =============================================================================
# fetch_b3_data.R
# Busca dados de cotações da B3 usando o pacote rb3 (COTAHIST)
# Filtra ações abaixo de R$10 e exporta JSON para integração com Python
#
# Uso: Rscript fetch_b3_data.R [arquivo_saida]
# Dependências: rb3, dplyr, jsonlite
# =============================================================================

suppressPackageStartupMessages({
  # Instala pacotes se necessário
  pkgs <- c("rb3", "dplyr", "jsonlite")
  for (pkg in pkgs) {
    if (!requireNamespace(pkg, quietly = TRUE)) {
      message(sprintf("Instalando pacote: %s ...", pkg))
      install.packages(pkg, repos = "https://cloud.r-project.org", quiet = TRUE)
    }
  }

  library(rb3)
  library(dplyr)
  library(jsonlite)
})

# ----------- Argumentos -------------------------------------------------------
args        <- commandArgs(trailingOnly = TRUE)
output_file <- if (length(args) > 0) args[1] else "data/cotahist.json"
max_preco   <- as.numeric(Sys.getenv("MAX_PRECO", "15"))  # R$10 + margem para filtro

dir.create(dirname(output_file), showWarnings = FALSE, recursive = TRUE)

# ----------- Funções auxiliares -----------------------------------------------

#' Tenta buscar COTAHIST retroagindo até `max_tentativas` dias úteis
fetch_cotahist <- function(max_tentativas = 7) {
  date <- Sys.Date()
  for (i in seq_len(max_tentativas)) {
    tryCatch({
      cat(sprintf("Tentando COTAHIST para %s ...\n", format(date, "%d/%m/%Y")))
      ch <- cotahist_get(date, type = "daily")
      if (!is.null(ch)) {
        cat(sprintf("Dados encontrados para %s\n", format(date, "%d/%m/%Y")))
        return(list(data = ch, date = date))
      }
    }, error = function(e) {
      cat(sprintf("  Data %s indisponível: %s\n", format(date, "%d/%m/%Y"), conditionMessage(e)))
    })
    # Volta 1 dia (finais de semana e feriados são pulados automaticamente)
    date <- date - 1
  }
  stop("Nenhum dado COTAHIST disponível nos últimos 7 dias.")
}

#' Calcula variação percentual entre dois preços
var_pct <- function(price_new, price_old) {
  if (is.na(price_new) || is.na(price_old) || price_old == 0) return(NA_real_)
  round(((price_new / price_old) - 1) * 100, 2)
}

# ----------- Busca de dados ---------------------------------------------------
cat("=== rb3 :: Coleta COTAHIST da B3 ===\n")
result <- tryCatch(
  fetch_cotahist(),
  error = function(e) {
    cat(sprintf("ERRO FATAL: %s\n", conditionMessage(e)), file = stderr())
    quit(status = 1)
  }
)

ch        <- result$data
ref_date  <- result$date

# Extrai ações do mercado à vista (tipo_mercado == 10)
equity <- tryCatch(
  cotahist_equity_get(ch),
  error = function(e) {
    # Fallback: tenta selecionar colunas básicas diretamente
    cat(sprintf("Aviso em cotahist_equity_get: %s\n", conditionMessage(e)))
    ch %>% filter(tipo_mercado == 10)
  }
)

cat(sprintf("Total de ativos no mercado à vista: %d\n", nrow(equity)))

# ----------- Filtros e transformações -----------------------------------------

# Identifica as colunas de preço (nomes podem variar por versão do rb3)
col_map <- list(
  ticker    = c("cod_negociacao", "ticker", "symbol"),
  empresa   = c("nome_resumido", "company", "name"),
  preco     = c("preco_ultimo", "close", "preco_fechamento"),
  abertura  = c("preco_abertura", "open"),
  maximo    = c("preco_maximo", "high"),
  minimo    = c("preco_minimo", "low"),
  medio     = c("preco_medio", "average"),
  volume    = c("volume_titulos_negociados", "volume", "financial_volume"),
  negocios  = c("numero_negocios", "trades")
)

resolve_col <- function(df, candidates) {
  found <- candidates[candidates %in% names(df)]
  if (length(found) == 0) return(NULL)
  found[1]
}

cols <- lapply(col_map, resolve_col, df = equity)
missing <- names(cols)[sapply(cols, is.null)]
if (length(missing) > 0) {
  cat(sprintf("Aviso: colunas não encontradas: %s\n", paste(missing, collapse = ", ")))
}

# Monta tibble padronizado
penny_stocks <- equity %>%
  transmute(
    ticker   = if (!is.null(cols$ticker))   .data[[cols$ticker]]   else NA_character_,
    empresa  = if (!is.null(cols$empresa))  .data[[cols$empresa]]  else NA_character_,
    preco    = if (!is.null(cols$preco))    as.numeric(.data[[cols$preco]])  else NA_real_,
    abertura = if (!is.null(cols$abertura)) as.numeric(.data[[cols$abertura]]) else NA_real_,
    maximo   = if (!is.null(cols$maximo))  as.numeric(.data[[cols$maximo]])  else NA_real_,
    minimo   = if (!is.null(cols$minimo))  as.numeric(.data[[cols$minimo]])  else NA_real_,
    medio    = if (!is.null(cols$medio))   as.numeric(.data[[cols$medio]])   else NA_real_,
    volume   = if (!is.null(cols$volume))  as.numeric(.data[[cols$volume]])  else NA_real_,
    negocios = if (!is.null(cols$negocios)) as.integer(.data[[cols$negocios]]) else NA_integer_
  ) %>%
  filter(
    !is.na(ticker),
    !is.na(preco),
    preco > 0,
    preco < max_preco,
    !is.na(volume),
    volume > 0
  ) %>%
  mutate(
    var_dia_pct = mapply(var_pct, preco, abertura)
  ) %>%
  arrange(desc(volume))

cat(sprintf("Ações filtradas (abaixo de R$%.2f): %d\n", max_preco, nrow(penny_stocks)))

if (nrow(penny_stocks) == 0) {
  cat("Nenhuma ação encontrada com os critérios definidos.\n", file = stderr())
  quit(status = 1)
}

# ----------- Exportação JSON ---------------------------------------------------
output <- list(
  fonte            = "rb3::cotahist_get",
  data_referencia  = format(ref_date, "%Y-%m-%d"),
  data_atualizacao = format(Sys.time(), "%d/%m/%Y %H:%M"),
  total            = nrow(penny_stocks),
  acoes            = penny_stocks
)

write(
  toJSON(output, auto_unbox = TRUE, digits = 4, na = "null"),
  file = output_file
)

cat(sprintf("Exportado: %s (%d registros)\n", output_file, nrow(penny_stocks)))
