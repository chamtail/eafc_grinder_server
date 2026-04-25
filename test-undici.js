// 测试 undici fetch
const { fetch } = require('undici');

const url = 'https://www.futbin.org/futbin/api/26/getSTCCheapest?definitionId=239653';

async function testUndici() {
  console.log('Testing with undici fetch...');
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 Edg/147.0.0.0',
      },
    });
    console.log('Status:', resp.status);
    console.log('StatusText:', resp.statusText);
    const text = await resp.text();
    console.log('Body (first 500 chars):', text.substring(0, 500));
  } catch (e) {
    console.error('Error:', e.message);
  }
}

testUndici();
