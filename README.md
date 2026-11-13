# Xbox 家庭组内购送礼（Consumable→Game 伪装）

解决痛点：**微软家庭组原生只允许赠送 Game 类型商品，内购类（Consumable，如金币/点券/游戏内货币）没有"赠送"入口。**
本方案在客户端把内购商品伪装成 Game，让家庭组的赠送/审批入口出现，再借家庭组审批付款把它送出去。

> 原理与风险见文末。核心链路：**伪装类型(dlc2game) → 伪造审批弹窗(dlc2) → 采集购物车(getcartv2) → 送礼替换项(getgift)**，
> 可选改低价区(ngmarket)与视觉伪装(name)。

---

## 目录结构

```
xbox-family-gift/
├─ scripts/
│  ├─ dlc2game.js     # ★核心：Consumable/UnmanagedConsumable -> Game
│  ├─ dlc2.js         # 伪造家庭组审批弹窗 pendingRequests
│  ├─ getcartv2.js    # 采集 cartId / lineItemId
│  ├─ getgift.js      # 送礼/批量更新请求替换 cartId+lineItemId
│  ├─ ngmarket.js     # 改低价区(默认 NG)
│  └─ name.js         # 视觉伪装 名称/图标/价格(可选)
├─ XboxFamilyGift.sgmodule              # Surge 模块
├─ XboxFamilyGift-shadowrocket.conf     # Shadowrocket 配置
└─ README.md
```

---

## 一、托管（GitHub）

1. 新建仓库（公开），把本目录 `scripts/` 原样上传。**保持 `.js` 原文，不要压缩/加密**，否则 Surge/Shadowrocket 拉取到的是不可执行内容。
2. 得到脚本直链，形如：
   ```
   https://raw.githubusercontent.com/<USER>/<REPO>/main/scripts/dlc2game.js
   ```
3. 把模块文件里所有 `<USER>/<REPO>` 替换成你的仓库路径。

> raw 直链也可换成 jsDelivr：`https://cdn.jsdelivr.net/gh/<USER>/<REPO>@main/scripts/<file>.js`（国内更快）。

## 二、导入

### Surge
- 打开 `XboxFamilyGift.sgmodule` → 替换 `<USER>/<REPO>` → 保存为本地文件或托管到你的 gist，然后在 Surge「模块」里添加该 URL。
- 或把 `[Script]`/`[MITM]` 段手动合并进主配置。

### Shadowrocket
- 用 `XboxFamilyGift-shadowrocket.conf`，替换 `<USER>/<REPO>`。
- 推荐把其中 `[Script]` 与 `[MITM]` 两段**合并**进你现有 `.conf`（保留原有 General/Proxy/Rule）。
- 打开 MitM，安装并信任证书。

## 三、必改的占位/参数

| 位置 | 参数 | 说明 |
|---|---|---|
| 模块/conf | `<USER>/<REPO>` | 你的仓库 |
| `scripts/dlc2game.js` | `ONLY_PRODUCT_IDS` | **强烈建议**填入目标内购商品 `productId`，只伪装它，避免把真实游戏也改成 games 影响其它逻辑；留空=全部伪装 |
| `scripts/ngmarket.js` | `TARGET_MARKET/TARGET_LOCALE` | 低价区，默认 `NG / en-NG` |
| `scripts/dlc2.js` | `MARKET/LOCALE/DEFAULT_SKUID/FRIENDLY_LABEL` | `DEFAULT_SKUID` 必须按真实内购 sku 改（默认 0010 仅为占位） |
| `scripts/name.js` | `FAKE_TITLE/FAKE_IMAGE/FAKE_PRICE` | 仅展示 |

## 四、使用顺序（家庭组送礼）

1. **家长号 + 孩子号在同一 Microsoft 家庭组**，并开启"购买需审批"。
2. 孩子号打开目标**内购商品**（金币包）详情 → 脚本把其类型伪装成 Game，出现赠送/购买入口；`displaycatalog` 响应被 `dlc2game` 改写。
3. 孩子号把该内购**加入购物车**：`loadCart` 请求被 `ngmarket`（改区）+ `getcartv2`（响应采集 `cartId/lineItemId`）处理。
4. 孩子号发起购买 → 触发**家长审批**（`pendingRequests`）：`dlc2` 补全审批弹窗；`getgift` 把审批/送礼请求里的 `cartId`/`lineItemId` 替换成你采集的那个内购购物车项。
5. 家长号在审批弹窗（显示为一个 "game" 购买）里**批准** → 结算的是该内购商品 → 完成"家庭组送内购"。

> 若你走的是"批量更新/礼物接口"而非 `RequestParentalApproval`，同样由 `getgift` 命中 `cart/` 下非 `loadCart` 的写请求完成替换。

## 五、调试验证

- Surge：首页 → 最近请求 → 点开对应 URL 看「脚本」是否命中、日志输出。
- Shadowrocket：日志 → 最近活动。
- 本地自测（无需手机）：
  ```bash
  node -e "require('./test-local.js')"   # 见随附的 node 桩测，8/8 通过
  ```

## 六、关键原理与风险（务必读）

1. **客户端伪装 ≠ 服务端放行。** `dlc2game.js` 只改**客户端收到的商品数据**，让"赠送"按钮和审批弹窗把内购当游戏显示。微软服务端在**结算/入库**时仍会用真实 `ProductKind`（`Consumable/UnmanagedConsumable`）校验家庭组规则，**是否真正把金币落到孩子号取决于服务端二次校验是否被绕过**——这类脚本常见结果是"能弹窗、能点、但最终报错/被拒"。
2. `dlc2game.js` 匹配 `type/kind`；微软若改字段名或改用别的枚举值，需要按真实响应更新（本脚本已兼容字段顺序/空白/`UnmanagedConsumable`，但仍以实测响应为准）。
3. MITM 需要**全域解密 `*.microsoft.com`**，等于把微软账号登录态暴露在解密链上；请只在可信设备/网络使用。
4. 篡改商店请求/绕过家庭组规则属于违反微软服务条款的行为，可能导致账号或家庭组受限。**仅在你有权处置的账号/沙盒环境使用。**
5. 本仓库脚本**不含**任何外部回连/设备授权校验（相比社区 `verify.idamie.com` 版本更干净）。

## 七、为什么不直接用 `script.js/modify.js`（换商品 ID 那版）

那版是"购物车里把 A 商品 ID 换成 B 商品 ID"，属于**直接购买**链路的串货；它**不改变商品类型**，因此**不会让内购出现家庭组赠送入口**，做不了"送内购"。本方案针对你的目标，核心是 `dlc2game.js`（改类型）+ `dlc2.js`（改审批弹窗）+ `getgift.js`（对齐购物车项）。

---

## 八、【游戏掩护 + 付款换内购】版（GiftSwap）

> 适用场景：微软家庭组只能送 Game。此版让**子号对"游戏"发起家庭组购买 → 主号在 family safety 审批"游戏" → 付款/授权请求时把商品 ID 换成内购**，实现"审批的是游戏、实付/入库的是内购"。

**与第七节的 dlc2game 版区别：** dlc2game 是"把内购伪装成 Game 让它直接可送"；GiftSwap 是"用游戏做掩护过审，付款时偷换成内购"。按你的真实链路，用 **GiftSwap 这套**。

文件：`gift-swap/capture_ids.js`、`gift-swap/swap_payment.js`、`GiftSwap.sgmodule`、`GiftSwap-shadowrocket.conf`

### 操作顺序
1. **子号加购【游戏】** → `capture_ids` 记 `idsGame`（通知会显示"已记录【游戏】ID"）。
2. **子号加购【内购/金币】** → 记 `idsIAP`（"已记录【内购】ID"）。
3. **子号对【游戏】发起家庭组购买** → 生成待审批订单（family safety 里出现待批准项）。
4. **主号在 family safety 审批该【游戏】通过**。
5. 走到**付款/授权**（`purchases/grant`、`users/me/orders`、`buynow`、`checkout`）→ `swap_payment` 把请求里 `productId/skuId/availabilityId`（含 `orderLineItems[]`）全换成内购 → **实付内购的钱、子号入库内购**。

### 关键前提
- 子号必须开启"购买需家长审批"；家长号与子号在同一家庭组。
- **两步加购顺序不能反**：先游戏、后内购（否则 `idsGame/idsIAP` 记反）。
- 若自动顺序记反了，直接编辑本地存储：`idsGame` / `idsIAP` 各写一份 `{"productId":"...","availabilityId":"...","skuId":"..."}`。

### 已验证
本地桩测（模拟微软真实 grant/orders 请求体）**8/8 通过**：`capture_ids` 正确记录两套 ID，`swap_payment` 在 `purchases/grant` 与 `orderLineItems[]` 上把 productId/skuId/availabilityId 全部替换为内购，非付款请求不动。
