import { Context, Schema, Session, h } from 'koishi';
import { areaNameToCode, areaCodeToName } from './area'
export const inject = ['database'];
export const name = 'anime-convention-lizard';
export const usage = `
# 🎉 开箱即用的漫展查询插件

## 简介
- **anime-convention-lizard** 是一款针对漫展查询与订阅的 Koishi 插件，对接B站会员购数据，通过简单的指令快速查询某城市举办的漫展，并提供订阅与管理功能。

- api还支持获取演出及本地生活的信息，后续更新可能会支持，也可能不更新了（）
---

<details>
<summary><strong><span style="font-size: 1.3em; color: #2a2a2a;">使用方法</span></strong></summary>

### 通过地区查询漫展
#### 示例：
<pre style="background-color: #f4f4f4; padding: 10px; border-radius: 4px; border: 1px solid #ddd;">漫展 查询 北京 // 查询北京市的漫展</pre>
<pre style="background-color: #f4f4f4; padding: 10px; border-radius: 4px; border: 1px solid #ddd;">漫展 查询 朝阳 // 查询北京市朝阳区的漫展</pre>

### 一键查询所有订阅的地区
#### 示例：
<pre style="background-color: #f4f4f4; padding: 10px; border-radius: 4px; border: 1px solid #ddd;">漫展 一键查询 // 查询你已订阅地区的漫展</pre>

### 订阅地区
#### 示例：
<pre style="background-color: #f4f4f4; padding: 10px; border-radius: 4px; border: 1px solid #ddd;">漫展 订阅 朝阳 // 订阅北京市朝阳区</pre>

### 取消订阅漫展关键词
#### 示例：
<pre style="background-color: #f4f4f4; padding: 10px; border-radius: 4px; border: 1px solid #ddd;">漫展 取消订阅 朝阳 // 取消订阅朝阳区</pre>
<pre style="background-color: #f4f4f4; padding: 10px; border-radius: 4px; border: 1px solid #ddd;">漫展 取消订阅 // 取消所有订阅</pre>

### 查看当前订阅列表
#### 示例：
<pre style="background-color: #f4f4f4; padding: 10px; border-radius: 4px; border: 1px solid #ddd;">漫展 订阅列表 // 查看当前订阅的地区列表</pre>
</details>

<details>
<summary><strong><span style="font-size: 1.3em; color: #2a2a2a;">如果要反馈建议或报告问题</span></strong></summary>

<strong>可以[点这里](https://github.com/lizard0126/anime-convention-lizard/issues)创建议题~</strong>
</details>

<details>
<summary><strong><span style="font-size: 1.3em; color: #2a2a2a;">如果喜欢我的插件</span></strong></summary>

<strong>可以[请我喝可乐](https://ifdian.net/a/lizard0126)，没准就有动力更新新功能了~</strong>
</details>
`;

export const Config = Schema.object({
  timeout: Schema.number().max(60000).default(15000).description('选择超时时长（秒数*1000）'),
});

declare module 'koishi' {
  interface Tables {
    anime_convention: Subscription;
  }
}

export interface Subscription {
  userId: string;
  channelId: string;
  area: string;
  createdAt: number;
}

const areaInputRegex = /^[\u4e00-\u9fa5]{2,7}(?:省|市|区|县)?$/

function resolveAreaCode(input: string): string | null {
  const text = input.trim()
  if (!areaInputRegex.test(text)) return null
  return areaNameToCode[text]
    || areaNameToCode[text + '省']
    || areaNameToCode[text + '市']
    || areaNameToCode[text + '区']
    || areaNameToCode[text + '县']
    || null
}

function formatListMessage(data: any[]) {
  return data.map((item, i) => `${i + 1}. ${item.project_name}`).join('\n')
}

function formatDetail(item: any) {
  let msg =
    `活动名称: ${item.project_name}\n` +
    `销售状态: ${item.sale_flag}\n` +
    `活动地址: ${item.district_name} - ${item.venue_name}\n` +
    `活动时间: ${item.start_time} - ${item.end_time}\n` +
    `想去人数: ${item.wish}\n` +
    `售票链接: https://show.bilibili.com/platform/detail.html?id=${item.project_id}\n`
  if (Array.isArray(item.tags) && item.tags.length) {
    msg += `活动标签: ${item.tags.map((t: any) => t.name).join(' / ')}\n`
  }
  if (item.jump_url) msg += `活动链接: ${item.jump_url}\n`
  if (item.sale_point) msg += `宣传卖点: ${item.sale_point}\n`
  if (Array.isArray(item.guests) && item.guests.length) {
    msg += `参与嘉宾: ${item.guests.map((t: any) => t.name).join(' / ')}\n`
  }
  return msg
}

async function fetchConventions(ctx: Context, area: string) {
  const url = `https://show.bilibili.com/api/ticket/project/listV2?version=134&page=1&pagesize=20&area=${area}&filter=&platform=web&p_type=展览`
  const res = await ctx.http.get(url)
  return Array.isArray(res.data.result) ? res.data.result : []
}

function cacheResult(userCache: Record<string, any>, userId: string, data: any[], session: Session, config) {
  userCache[userId] = { cache: data }
  userCache[userId].timeoutId = setTimeout(() => {
    delete userCache[userId]
    session.send('超时未选择，请重新查询。')
  }, config.timeout)
}

export function apply(ctx: Context, config: { apiUrl: string }) {
  ctx.model.extend('anime_convention', {
    userId: 'string',
    channelId: 'string',
    area: 'string',
    createdAt: 'integer',
  }, { primary: ['userId', 'channelId', 'area'] });

  const userSearchCache: Record<string, { cache: any[]; timeoutId?: NodeJS.Timeout }> = {};
  const getChannelId = (session: Session) => session.guildId ? session.channelId : `private:${session.userId}`;

  const cmd = ctx.command('漫展', '地区漫展查询和订阅管理');

  cmd.subcommand('.查询 <area>', '查询某地区的漫展')
    .action(async ({ session }, area) => {
      if (!area) return session.send('请提供查询的地区，例如：漫展 查询 北京');
      if (userSearchCache[session.userId]) clearTimeout(userSearchCache[session.userId].timeoutId);

      const areaCode = resolveAreaCode(area)
      if (!areaCode) return session.send('未识别的地区，请输入如：北京 / 南京 / 朝阳区')

      try {
        const data = await fetchConventions(ctx, areaCode)
        if (!data.length) return session.send('未找到相关地区的漫展信息。');

        cacheResult(userSearchCache, session.userId, data, session, config)
        session.send(`找到以下漫展：\n${formatListMessage(data)}\n请输入序号查看详情，输入“0”取消。`);
      } catch (err) {
        ctx.logger.error('查询 API 失败:', err)
        session.send('查询失败，请稍后重试。')
      }
    });

  cmd.subcommand('.一键查询', '查询订阅地区的漫展')
    .action(async ({ session }) => {
      const subscriptions: Subscription[] = await ctx.database.get('anime_convention', { userId: session.userId, channelId: getChannelId(session) });
      if (!subscriptions.length) return session.send('你没有订阅任何地区。');

      const results = await Promise.all(subscriptions.map(sub => fetchConventions(ctx, sub.area).catch(() => [])))
      const allResults = results.flat()
      if (!allResults.length) return session.send('未找到订阅地区的漫展。');

      cacheResult(userSearchCache, session.userId, allResults, session, config)
      session.send(`订阅地区的漫展：\n${formatListMessage(allResults)}\n请输入序号查看详情，输入“0”取消。`);
    });

  cmd.subcommand('.订阅 <area>', '订阅地区')
    .action(async ({ session }, area) => {
      const areaCode = resolveAreaCode(area)
      if (!areaCode) return session.send('未识别的地区，示例：漫展 订阅 南京')
      await ctx.database.upsert('anime_convention', [{
        userId: session.userId,
        channelId: getChannelId(session),
        area: areaCode,
        createdAt: Date.now(),
      }])
      session.send(`已订阅「${area}」的漫展。`);
    });

  cmd.subcommand('.取消订阅 [area]', '取消订阅')
    .action(async ({ session }, area) => {
      const channelId = getChannelId(session);
      if (!area) {
        await session.send('确定取消所有订阅？（是/否）');
        if ((await session.prompt(10000))?.toLowerCase() === '是') {
          await ctx.database.remove('anime_convention', { userId: session.userId, channelId });
          return session.send('已取消所有订阅。');
        }
        return session.send('操作取消。');
      }

      const areaCode = resolveAreaCode(area)
      if (!areaCode) return session.send('未识别的地区')
      const deleted = await ctx.database.remove('anime_convention', { userId: session.userId, channelId, area: areaCode })
      session.send(deleted ? `已取消订阅「${area}」。` : `未找到「${area}」的订阅。`);
    });

  cmd.subcommand('.订阅列表', '查看订阅列表')
    .action(async ({ session }) => {
      const subs = await ctx.database.get('anime_convention', { userId: session.userId, channelId: getChannelId(session) })
      if (!subs.length) return session.send('你没有订阅任何地区。')
      session.send('你订阅的地区：\n' + subs.map(sub => `- ${areaCodeToName[sub.area] ?? sub.area}`).join('\n'));
    });

  ctx.middleware(async (session, next) => {
    const userCache = userSearchCache[session.userId];
    if (!userCache?.cache) return next();

    const choice = parseInt(session.content?.trim() || '')
    if (isNaN(choice) || choice < 0 || choice > userCache.cache.length) {
      return session.send('无效选择，请输入正确的序号。');
    }

    if (choice === 0) {
      clearTimeout(userCache.timeoutId)
      delete userSearchCache[session.userId]
      return session.send('已取消操作。')
    }

    clearTimeout(userCache.timeoutId)
    const selectedItem = userCache.cache[choice - 1]

    try {
      const img = await ctx.http.get(`https:${selectedItem.cover}`, { responseType: 'arraybuffer' })
      const imageData = `data:image/jpeg;base64,${Buffer.from(img).toString('base64')}`
      await session.send(`${h.image(imageData)}\n${formatDetail(selectedItem)}`)
    } catch {
      await session.send(formatDetail(selectedItem))
    }

    delete userSearchCache[session.userId]
  });
}