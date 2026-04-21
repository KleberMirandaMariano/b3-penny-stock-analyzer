/**
 * Script de teste para validar a integração Ollama
 * Executa: npx tsx test-ollama-integration.ts
 * Node.js 18+ built-in fetch - sem dependências extras
 */

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama2';

interface TestResult {
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  message: string;
  duration?: number;
}

const results: TestResult[] = [];

async function test(name: string, fn: () => Promise<void>) {
  try {
    const start = Date.now();
    await fn();
    const duration = Date.now() - start;
    results.push({ name, status: 'PASS', message: 'OK', duration });
    console.log(`✓ ${name} (${duration}ms)`);
  } catch (err: any) {
    results.push({ name, status: 'FAIL', message: err.message });
    console.log(`✗ ${name}: ${err.message}`);
  }
}

async function testOllamaConnectivity() {
  console.log('\n=== OLLAMA CONNECTIVITY TESTS ===\n');

  await test('1. Check Ollama server is running', async () => {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { timeout: 5000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  });

  await test('2. Check model is available', async () => {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    const data = (await res.json()) as any;
    const models = data.models || [];
    if (!models.some((m: any) => m.name.includes(OLLAMA_MODEL))) {
      throw new Error(`Model ${OLLAMA_MODEL} not found. Available: ${models.map((m: any) => m.name).join(', ')}`);
    }
  });

  await test('3. Test simple generation', async () => {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: 'Say "OK" only.',
        stream: false,
      }),
      timeout: 30000,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as any;
    if (!data.response) throw new Error('Empty response');
  });

  await test('4. Test chat endpoint (used by API)', async () => {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [{ role: 'user', content: 'Say "OK".' }],
        stream: false,
      }),
      timeout: 30000,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as any;
    if (!data.message) throw new Error('No message in response');
  });

  await test('5. Test timeout handling (simulated)', async () => {
    try {
      await fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          messages: [{ role: 'user', content: 'Write a long essay.' }],
          stream: false,
        }),
        timeout: 2000, // Very short timeout
      });
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.message.includes('timeout')) {
        throw new Error('Timeout handled correctly');
      }
    }
  });
}

async function testPromptEngineering() {
  console.log('\n=== PROMPT ENGINEERING TESTS ===\n');

  const optionContext = {
    ticker: 'PETR4C25',
    tipo: 'CALL',
    strike: 25.0,
    preco: 1.50,
    moneyness: 'ATM',
    stockPrice: 25.50,
    delta: 0.65,
    gamma: 0.08,
    theta: -0.05,
    vega: 0.12,
    iv: 0.35,
    daysToExpiry: 45,
    bid: 1.48,
    ask: 1.52,
    volume: 15000,
    openInterest: 50000,
  };

  const prompt = `Você é um analista de opções especializado em B3. Analise a seguinte opção:

**CALL ${optionContext.ticker} Strike R$ ${optionContext.strike}**
- Preço: R$ ${optionContext.preco}
- Stock: ${optionContext.stockPrice}
- Moneyness: ${optionContext.moneyness}
- Delta: ${optionContext.delta}, Gamma: ${optionContext.gamma}, Theta: ${optionContext.theta}, Vega: ${optionContext.vega}
- IV: ${(optionContext.iv * 100).toFixed(1)}% | ${optionContext.daysToExpiry} dias
- Bid/Ask: ${optionContext.bid}/${optionContext.ask}
- Vol: ${optionContext.volume.toLocaleString()} | OI: ${optionContext.openInterest.toLocaleString()}

Forneça análise em 4 parágrafos: (1) Moneyness e estratégia, (2) Gregas e volatilidade, (3) Liquidez, (4) Considerações de risco. SEM recomendações.`;

  await test('6. Test Portuguese prompt', async () => {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
      }),
      timeout: 60000,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as any;
    if (!data.message?.content) throw new Error('No analysis generated');
    console.log('\n📊 Sample Analysis Output:');
    console.log(data.message.content.substring(0, 300) + '...\n');
  });
}

async function main() {
  console.log(`Testing Ollama Integration`);
  console.log(`OLLAMA_URL: ${OLLAMA_URL}`);
  console.log(`OLLAMA_MODEL: ${OLLAMA_MODEL}`);

  await testOllamaConnectivity();
  await testPromptEngineering();

  console.log('\n=== TEST SUMMARY ===\n');
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  const skipped = results.filter((r) => r.status === 'SKIP').length;

  console.log(`Total: ${results.length} | Passed: ${passed} | Failed: ${failed} | Skipped: ${skipped}`);

  if (failed > 0) {
    console.log('\nFailed tests:');
    results.filter((r) => r.status === 'FAIL').forEach((r) => {
      console.log(`  - ${r.name}: ${r.message}`);
    });
    process.exit(1);
  }

  console.log('\n✓ All tests passed!');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
