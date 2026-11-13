const {run}=require('./_harness.js');
let pass=0,fail=0;
const ok=(n,c,e)=>{c?(pass++,console.log('PASS '+n)):(fail++,console.log('FAIL '+n+(e?'\n   :: '+e:'')))};

// 真实抓包值
const GAME={productId:'9P36PB4N42GW',availabilityId:'9XP08PCG1038',skuId:'0010'}; // COD MW4
const COIN={productId:'9N1Q2GBW6LP0',availabilityId:'B21NVMHMJ32K',skuId:'0010'}; // 5000 COD Points

let store={};
// step1: 加游戏 (#159 真实body)
let b159=JSON.stringify({market:'US',locale:'en-US',itemsToAdd:{items:[{productId:GAME.productId,skuId:GAME.skuId,availabilityId:GAME.availabilityId,quantity:1,campaignId:'xboxcomct'}]}});
run('/Users/weiliu/Downloads/repos/xbox-family-gift/gift-swap/capture_ids.js',
 {store,request:{method:'PUT',url:'https://cart.production.store-web.dynamics.com/v1.0/cart/loadCart?cartType=consumer&appId=XboxWeb',headers:{},body:b159}});
ok('capture GAME', JSON.parse(store.idsGame||'{}').productId===GAME.productId, JSON.stringify(store.idsGame));

// step2: 加金币 (#145 真实body)
let b145=JSON.stringify({market:'US',locale:'en-US',itemsToAdd:{items:[{productId:COIN.productId,skuId:COIN.skuId,availabilityId:COIN.availabilityId,quantity:1,campaignId:'xboxcomct'}]}});
run('/Users/weiliu/Downloads/repos/xbox-family-gift/gift-swap/capture_ids.js',
 {store,request:{method:'PUT',url:'https://cart.production.store-web.dynamics.com/v1.0/cart/loadCart?cartType=consumer&appId=XboxWeb',headers:{},body:b145}});
ok('capture COIN', JSON.parse(store.idsIAP||'{}').productId===COIN.productId, JSON.stringify(store.idsIAP));

// step3: #39 approve (真实body) -> 应换成内购
let b39='{"onBehalfOfPuid":"985160375074030","orderId":"a28236a9-e965-91e3-d60d-7caa5b8b1560","productId":"9P36PB4N42GW","skuId":"0010"}';
let r=run('/Users/weiliu/Downloads/repos/xbox-family-gift/gift-swap/swap_payment.js',
 {store,request:{method:'POST',url:'https://account.microsoft.com/family/api/buy/requests/approve',headers:{},body:b39}});
let o=JSON.parse(r.done.body);
ok('#39 approve productId->coin', o.productId===COIN.productId, r.done.body);
ok('#39 approve skuId kept', o.skuId===COIN.skuId, r.done.body);
ok('#39 orderId untouched', o.orderId==='a28236a9-e965-91e3-d60d-7caa5b8b1560', r.done.body);

// step4: #38 buynow form products=[...] (真实结构) -> 换成内购
let products=encodeURIComponent(JSON.stringify([{productId:GAME.productId,skuId:GAME.skuId,availabilityId:GAME.availabilityId}]));
let b38='data=%7B%22usePurchaseSdk%22%3Atrue%7D&market=US&products='+products+'&scenario=parentApproval&callerApplicationId=AMCFamilySafetyApp';
r=run('/Users/weiliu/Downloads/repos/xbox-family-gift/gift-swap/swap_payment.js',
 {store,request:{method:'POST',url:'https://www.microsoft.com/store/purchase/buynowui/buynow?ms-cv=X',headers:{},body:b38}});
let parsed=decodeURIComponent(r.done.body);
ok('#38 buynow products productId->coin', parsed.indexOf(COIN.productId)!==-1 && parsed.indexOf(GAME.productId)===-1, parsed.slice(0,300));
ok('#38 buynow keeps availability coin', parsed.indexOf(COIN.availabilityId)!==-1, parsed.slice(0,300));

// step5: #43 orders (真实body) -> items[].productId 换
let b43='{"orderId":"a28236a9","clientContext":{"client":"AccountMicrosoftCom"},"language":"en-US","market":"US","items":[{"availabilityId":"9XP08PCG1038","productId":"9P36PB4N42GW","skuId":"0010","quantity":1,"beneficiary":{"identityType":"Msa","identityValue":"985160375074030"}}]}';
r=run('/Users/weiliu/Downloads/repos/xbox-family-gift/gift-swap/swap_payment.js',
 {store,request:{method:'POST',url:'https://purchase.md.mp.microsoft.com/v7.0/users/me/orders',headers:{},body:b43}});
o=JSON.parse(r.done.body);
ok('#43 orders items[0].productId->coin', o.items[0].productId===COIN.productId, r.done.body);
ok('#43 orders items[0].avail->coin', o.items[0].availabilityId===COIN.availabilityId, r.done.body);

// step6: unrelated url untouched
r=run('/Users/weiliu/Downloads/repos/xbox-family-gift/gift-swap/swap_payment.js',
 {store,request:{method:'GET',url:'https://account.microsoft.com/family/api/buy/requests?onBehalfOfPuid=1',headers:{},body:''}});
ok('unrelated untouched', r.done.body===undefined || r.done.body==='', JSON.stringify(r.done));

console.log('\n== '+pass+' passed, '+fail+' failed ==');
process.exit(fail?1:0);
