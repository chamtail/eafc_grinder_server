// 测试 futbin 返回的数据格式
const { fetch } = require('undici');

async function testFormat() {
  const resp = await fetch('https://www.futbin.org/futbin/api/26/getSTCCheapest?definitionId=239653');
  const data = await resp.json();
  console.log(JSON.stringify(data, null, 2).substring(0, 2000));
}

testFormat();
