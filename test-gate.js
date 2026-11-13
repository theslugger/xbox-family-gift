const {run}=require('./_harness.js');
let pass=0,fail=0;
const ok=(n,c,e)=>{c?(pass++,console.log('PASS '+n)):(fail++,console.log('FAIL '+n+(e?' :: '+e:'')))};
const GAME={productId:'9P36PB4N42GW',availabilityId:'9XP08PCG1038',skuId:'0010'};
const COIN={productId:'9N1Q2GBW6LP0',availabilityId:'B21NVMHMJ32K',skuId:'0010'};
const SWAP='/Users/weiliu/Downloads/repos/xbox-family-gift/gift-swap/swap_payment.js';
const FLAG='/Users/weiliu/Downloads/repos/xbox-family-gift/gift-swap/approve_flag.js';
const b43='{"orderId":"a28236a9","language":"en-US","market":"US","items":[{"availabilityId":"9XP08PCG1038","productId":"9P36PB4N42GW","skuId":"0010","quantity":1,"beneficiary":{"identityType":"Msa","identityValue":"985160375074030"}}]}';

// 场景1: 未批准前，子号发起 orders -> 绝不能替换
let store={idsGame:JSON.stringify(GAME),idsIAP:JSON.stringify(COIN)};
let r=run(SWAP,{store,request:{method:'POST',url:'https://purchase.md.mp.microsoft.com/v7.0/users/me/orders',headers:{},body:b43}});
ok('未批准 orders 不替换', r.done.body===undefined || r.done.body===b43, JSON.stringify(r.done));
ok('未批准 不弹窗', r.logs.filter(l=>l.includes('替换')).length===0, r.logs.join('|'));

// 场景2: 主号点批准 -> approve_flag 打标记
r=run(FLAG,{store,request:{method:'POST',url:'https://account.microsoft.com/family/api/buy/requests/approve',headers:{},body:'{"orderId":"x"}'}});
ok('approve 打标记', !!store.approvedTime, JSON.stringify(store.approvedTime));
ok('approve 弹窗', r.logs.some(l=>l.includes('已批准')), r.logs.join('|'));

// 场景3: 批准后再来 orders -> 替换
r=run(SWAP,{store,request:{method:'POST',url:'https://purchase.md.mp.microsoft.com/v7.0/users/me/orders',headers:{},body:b43}});
let o=JSON.parse(r.done.body);
ok('批准后 orders 替换为金币', o.items[0].productId===COIN.productId, r.done.body);
ok('批准后 弹窗', r.logs.some(l=>l.includes('替换')), r.logs.join('|'));

console.log('\n== '+pass+' passed, '+fail+' failed ==');
process.exit(fail?1:0);
