const {run}=require('./_harness.js');
let pass=0,fail=0;
const ok=(n,c,e)=>{c?(pass++,console.log('PASS '+n)):(fail++,console.log('FAIL '+n+(e?'\n :: '+e:'')))};
const GAME={productId:'9P36PB4N42GW',availabilityId:'9XP08PCG1038',skuId:'0010'};
const COIN={productId:'9N1Q2GBW6LP0',availabilityId:'B21NVMHMJ32K',skuId:'0010'};
const SWAP='/Users/weiliu/Downloads/repos/xbox-family-gift/gift-swap/swap_payment.js';
const store={idsGame:JSON.stringify(GAME),idsIAP:JSON.stringify(COIN)};

// 真实 #11: 主号 safety buynow (callerApplicationId=AMCFamilySafetyApp) -> 必须替换
let prod=encodeURIComponent(JSON.stringify([{productId:GAME.productId,skuId:GAME.skuId,availabilityId:GAME.availabilityId}]));
let b_parent='data=%7B%22usePurchaseSdk%22%3Atrue%7D&market=US&products='+prod+'&callerApplicationId=AMCFamilySafetyApp&scenario=parentApproval&purchaseOrderId=de24b7fc';
let r=run(SWAP,{store,request:{method:'POST',url:'https://www.microsoft.com/store/purchase/buynowui/buynow?ms-cv=X',headers:{},body:b_parent}});
let d=decodeURIComponent(r.done.body);
ok('safety buynow 替换为金币', d.indexOf(COIN.productId)!==-1 && d.indexOf(GAME.productId)===-1, d.slice(0,250));
ok('safety buynow 保留 callerApplicationId', d.indexOf('AMCFamilySafetyApp')!==-1);
ok('safety buynow 弹窗', r.logs.some(l=>l.includes('已替换为内购')));

// 真实 #131: 子号XboxCom buynow -> 绝不能替换
let b_child='data=%7B%7D&market=US&products='+prod+'&callerApplicationId=XboxCom';
r=run(SWAP,{store,request:{method:'POST',url:'https://www.microsoft.com/store/purchase/buynowui/buynow?ms-cv=Y',headers:{},body:b_child}});
ok('XboxCom buynow 不替换', r.done.body===undefined || r.done.body===b_child, JSON.stringify(r.done));

// orders / approve -> 不碰
r=run(SWAP,{store,request:{method:'POST',url:'https://purchase.md.mp.microsoft.com/v7.0/users/me/orders',headers:{},body:'{"items":[{"productId":"'+GAME.productId+'"}]}'}});
ok('orders 不碰', r.done.body===undefined);
r=run(SWAP,{store,request:{method:'POST',url:'https://account.microsoft.com/family/api/buy/requests/approve',headers:{},body:'{"productId":"'+GAME.productId+'"}'}});
ok('approve 不碰', r.done.body===undefined);

console.log('\n== '+pass+' passed, '+fail+' failed ==');
process.exit(fail?1:0);
