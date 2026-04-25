// 测试 futbin API 访问
const url = 'https://www.futbin.org/futbin/api/26/getSTCCheapest?definitionId=239653';

async function testFetch() {
  console.log('Testing with native fetch...');
  try {
    const resp = await fetch(url);
    console.log('Status:', resp.status);
    console.log('StatusText:', resp.statusText);
    const text = await resp.text();
    console.log('Body (first 500 chars):', text.substring(0, 500));
  } catch (e) {
    console.error('Error:', e.message);
  }
}

testFetch();
