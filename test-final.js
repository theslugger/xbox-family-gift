const {run}=require('./_harness.js');
let pass=0,fail=0;
const ok=(n,c,e)=>{c?(pass++,console.log('PASS '+n)):(fail++,console.log('FAIL '+n+(e?'\n :: '+e:'')))};
const GAME={productId:'9P36PB4N42GW',availabilityId:'9XP08PCG1038',skuId:'0010'};
const COIN={productId:'9N1Q2GBW6LP0',availabilityId:'B21NVMHMJ32K',skuId:'0010'};
let store={idsGame:JSON.stringify(GAME),idsIAP:JSON.stringify(COIN)};
const SWAP='./gift-swap/swap_payment.js';

// 1) #43 orders (真实body) -> items[] 换成金币
let b43='{"orderId":"a28236a9-e965-91e3-d60d-7caa5b8b1560","clientContext":{"client":"AccountMicrosoftCom"},"language":"en-US","market":"US","items":[{"availabilityId":"9XP08PCG1038","productId":"9P36PB4N42GW","skuId":"0010","quantity":1,"beneficiary":{"identityType":"Msa","identityValue":"985160375074030"}}]}';
let r=run(SWAP,{store,request:{method:'POST',url:'https://purchase.md.mp.microsoft.com/v7.0/users/me/orders',headers:{},body:b43}});
let o=JSON.parse(r.done.body);
ok('#43 orders productId->coin', o.items[0].productId===COIN.productId, r.done.body);
ok('#43 orders availability->coin', o.items[0].availabilityId===COIN.availabilityId, r.done.body);
ok('#43 orderId kept', o.orderId==='a28236a9-e965-91e3-d60d-7caa5b8b1560', r.done.body);
ok('#43 beneficiary kept child', o.items[0].beneficiary.identityValue==='985160375074030', r.done.body);

// 2) #38 buynow products -> 金币
let products=encodeURIComponent(JSON.stringify([{productId:GAME.productId,skuId:GAME.skuId,availabilityId:GAME.availabilityId}]));
let b38='data=%7B%22usePurchaseSdk%22%3Atrue%7D&market=US&products='+products+'&scenario=parentApproval';
r=run(SWAP,{store,request:{method:'POST',url:'https://www.microsoft.com/store/purchase/buynowui/buynow?ms-cv=X',headers:{},body:b38}});
let d=decodeURIComponent(r.done.body);
ok('#38 buynow productId->coin', d.indexOf(COIN.productId)!==-1 && d.indexOf(GAME.productId)===-1, d.slice(0,200));

// 3) #39 approve -> 必须【不动】(关键：不能过早替换)
let b39='{"onBehalfOfPuid":"985160375074030","orderId":"a28236a9-e965-91e3-d60d-7caa5b8b1560","productId":"9P36PB4N42GW","skuId":"0010"}';
r=run(SWAP,{store,request:{method:'POST',url:'https://account.microsoft.com/family/api/buy/requests/approve',headers:{},body:b39}});
ok('#39 approve UNTOUCHED', r.done.body===undefined || r.done.body===b39, JSON.stringify(r.done));

// 4) loadCart -> 不动
r=run(SWAP,{store,request:{method:'PUT',url:'https://cart.production.store-web.dynamics.com/v1.0/cart/loadCart?x=1',headers:{},body:b43}});
ok('loadCart UNTOUCHED', r.done.body===undefined || r.done.body===b43, JSON.stringify(r.done));

console.log('\n== '+pass+' passed, '+fail+' failed ==');
process.exit(fail?1:0);
