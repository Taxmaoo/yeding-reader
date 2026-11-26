export const DEFAULT_SETTINGS = Object.freeze({
  size: 20, leading: 1.9, margin: 23, theme: 'paper', mode: 'page', font: 'serif',
});

const HEADING = /^(?:第\s*[零〇○一二三四五六七八九十百千万亿两壹贰叁肆伍陆柒捌玖拾\d０-９]+\s*[章回节卷部篇集]|序章|序言|楔子|引子|前言|后记|尾声|终章|番外(?:篇)?|chapter\s+\d+\b)/i;
const SECTION_SIZE = 6500;

export function decodeTxt(buffer, encoding = 'auto') {
  const bytes = new Uint8Array(buffer);
  const hasUtf16Bom = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);
  let text;
  if (encoding !== 'auto') {
    text = new TextDecoder(encoding).decode(bytes);
  } else if (hasUtf16Bom) {
    text = new TextDecoder(bytes[0] === 0xff ? 'utf-16le' : 'utf-16be', { fatal: true }).decode(bytes);
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      text = new TextDecoder('gb18030', { fatal: true }).decode(bytes);
    }
  }
  text = text.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n');
  if (!text.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) {
    throw new Error('empty-or-binary');
  }
  return text;
}

export function indexText(text) {
  const headings = [];
  for (const match of text.matchAll(/^[ \t\u3000]*\S[^\n]{0,69}$/gm)) {
    if (match[0].includes('\n')) continue;
    const title = match[0].trim();
    if (HEADING.test(title) && !/[。！？!?；;]$/.test(title)) {
      const start = match.index;
      headings.push({ title, start, headingEnd: Math.min(text.length, start + match[0].length + 1) });
    }
  }
  const chapters = headings.slice();
  if (!chapters.length) {
    chapters.push({ title: '正文', start: 0, headingEnd: 0 });
  } else if (chapters[0].start > 0) {
    if (text.slice(0, chapters[0].start).trim()) {
      chapters.unshift({ title: '开篇', start: 0, headingEnd: 0 });
    } else {
      chapters[0] = { ...chapters[0], start: 0 };
    }
  }

  const sections = [];
  chapters.forEach((chapter, index) => {
    const end = chapters[index + 1]?.start ?? text.length;
    for (let start = chapter.start; start < end;) {
      let limit = Math.min(start + SECTION_SIZE, end);
      if (limit < end) {
        const windowStart = start + SECTION_SIZE / 2 + 1;
        const newline = text.slice(windowStart, limit).lastIndexOf('\n');
        if (newline !== -1) limit = windowStart + newline + 1;
        else if (isLowSurrogate(text.charCodeAt(limit))) limit--;
      }
      sections.push({
        start, end: limit, title: chapter.title, chapter: index,
        headingEnd: start === chapter.start ? chapter.headingEnd : start,
      });
      start = limit;
    }
  });
  return { chapters, sections, hasHeadings: headings.length > 0 };
}

export function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

export function sectionAt(sections, offset) {
  let low = 0;
  let high = sections.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (sections[mid].start <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}

export function progressAt(offset, length, finished = false) {
  return finished ? 100 : Math.max(0, Math.min(99, Math.floor(offset * 100 / Math.max(1, length))));
}

export const SAMPLE = {
  id: 'sample-mountain-post',
  title: '山里的邮局',
  text: `第一章　今天有信

山里的邮局每周只开三天。周二、周四和周六，邮递员老周会把绿色的门推开，替它挂上一块小木牌。木牌上写着：今天有信。

镇上的孩子总觉得这句话奇怪。没有信的时候，邮局为什么不开门？老周只是笑笑，说山里路远，信来得慢，等信的人却不一定慢。

那年冬天，雪下得比往年早。通往山外的公路封了，邮车停在半山腰，只有老周还照常背着帆布包出门。包里装着几封新信，还有一只用蓝线绕好的小盒子。

路过石桥时，有人把一壶热茶放在栏杆上。老周认得壶底用红漆写的名字，却从来没问过是谁放的。他喝一口，把壶盖拧好，留下第二天要捎的报纸。溪水在冰下响着，像有人贴着桥面念一封很长的信。

第二章　一片新叶

住在溪边的阿遥，每周都来问一次有没有她的信。她的妈妈去海边工作，答应每月写一封信。前两个月，信都准时到了。这个月，已经晚了十一天。

“兴许是山路太远了。”老周把手揣进棉袄口袋。

阿遥点点头，却没有马上走。她望了望窗台上的绿萝。那盆花是妈妈离开前留下的，最近长出一片很小的新叶。

“那我明天再来。”她说。

老周把包里的蓝线盒子放在柜台下。他已经去过三趟车站，托人问过海边的消息。公路没通，电话也时断时续。他写了一封信给海边的站点，把阿遥窗台上的新叶仔细描述了一遍。

那天阿遥回得很晚。山路上有一段积了冰，她伸开双手一步步往前走。到了门前，她仰头看了一会儿月亮。妈妈说过，山里和海边看到的是同一个月亮。阿遥觉得这倒挺好，一路上什么都能晚来，抬起头的事不用等。

第三章　走慢一点

雪停后的第一个周六，邮局的门比平常开得早。阿遥跑上坡时，木牌还在门后，没有挂出来。她踮脚往窗口看，正好看见老周把一张信纸折好，放进蓝色的小盒子。

盒子外头缠着一圈蓝线，里面是一封从海边寄来的信。潮水把信角洇开了一点，字却都清楚。妈妈说她换了新的工作，等春天一到就回来。她还画了一棵小树，树梢上顶着一片嫩绿的新叶。

“这封信走得可真久。”阿遥摸着信纸。

“有些路，走慢一点也会到。”老周说。

那天回去以后，阿遥把信放在窗台上。绿萝的新叶对着那张画，轻轻晃了一下。她从作业本上撕下一张纸，又想了想，换了一张厚点的。她打算回一封长信，把溪边的冰、窗台的新叶，还有每周三天开门的邮局，都写给妈妈。`,
};
