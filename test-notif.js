const {run}=require('./_harness.js');
let pass=0,fail=0;
const ok=(n,c,e)=>{c?(pass++,console.log('PASS '+n)):(fail++,console.log('FAIL '+n+(e?' :: '+e:'')))};
const GAME={productId:'9P36PB4N42GW',availabilityId:'9XP08PCG1038',skuId:'0010'};
const COIN={productId:'9N1Q2GBW6LP0',availabilityId:'B21NVMHMJ32K',skuId:'0010'};
const CAP='/Users/weiliu/Downloads/repos/xbox-family-gift/gift-swap/capture_ids.js';
let store={};

// 1) 加游戏 (#159 真实) -> 弹①
let b159=JSON.stringify({market:'US',itemsToAdd:{items:[{productId:GAME.productId,skuId:GAME.skuId,availabilityId:GAME.availabilityId,title:'Call of Duty MW4',quantity:1}]}});
let r=run(CAP,{store,request:{method:'PUT',url:'https://cart.production.store-web.dynamics.com/v1.0/cart/loadCart',headers:{},body:b159}});
ok('add game -> idsGame', JSON.parse(store.idsGame||'{}').productId===GAME.productId);
ok('add game -> notif ①', r.logs.some(l=>l.includes('①【游戏】已记录')), r.logs.join('|'));

// 2) 加金币 (#145 真实) -> 弹②
let b145=JSON.stringify({market:'US',itemsToAdd:{items:[{productId:COIN.productId,skuId:COIN.skuId,availabilityId:COIN.availabilityId,title:'5000 COD Points',quantity:1}]}});
r=run(CAP,{store,request:{method:'PUT',url:'https://cart.production.store-web.dynamics.com/v1.0/cart/loadCart',headers:{},body:b145}});
ok('add coin -> idsIAP', JSON.parse(store.idsIAP||'{}').productId===COIN.productId);
ok('add coin -> notif ②', r.logs.some(l=>l.includes('②【内购】已记录')), r.logs.join('|'));

// 3) 重复加金币 -> 不应再弹
r=run(CAP,{store,request:{method:'PUT',url:'https://cart.production.store-web.dynamics.com/v1.0/cart/loadCart',headers:{},body:b145}});
ok('repeat coin -> no notif', r.logs.filter(l=>l.includes('已记录')).length===0, r.logs.join('|'));

// 4) loadCart 重发整袋(游戏+金币) -> 不应误改
let both=JSON.stringify({itemsToAdd:{items:[{productId:GAME.productId,skuId:GAME.skuId,availabilityId:GAME.availabilityId},{productId:COIN.productId,skuId:COIN.skuId,availabilityId:COIN.availabilityId}]}});
r=run(CAP,{store,request:{method:'PUT',url:'https://cart.production.store-web.dynamics.com/v1.0/cart/loadCart',headers:{},body:both}});
ok('both already recorded -> no change', r.logs.filter(l=>l.includes('已记录')).length===0 && JSON.parse(store.idsGame).productId===GAME.productId && JSON.parse(store.idsIAP).productId===COIN.productId);

console.log('\n== '+pass+' passed, '+fail+' failed ==');
process.exit(fail?1:0);
