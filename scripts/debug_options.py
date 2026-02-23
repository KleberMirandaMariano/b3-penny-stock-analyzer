import yfinance as yf
try:
    ticker = "TASA3.SA"
    yf_ticker = yf.Ticker(ticker)
    print(f"Ticker: {ticker}")
    print(f"Options: {yf_ticker.options}")
    if yf_ticker.options:
        chain = yf_ticker.option_chain(yf_ticker.options[0])
        print(f"Calls found: {len(chain.calls)}")
        print(f"Puts found: {len(chain.puts)}")
except Exception as e:
    print(f"Error: {e}")
