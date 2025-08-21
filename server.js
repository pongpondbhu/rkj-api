const express = require('express');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.urlencoded({ extended: true }));
const PORT = process.env.PORT || 3000;

const thaiMonths = {
  'ม.ค.': '01', 'ม.ค': '01',
  'ก.พ.': '02', 'ก.พ': '02',
  'มี.ค.': '03', 'มี.ค': '03',
  'เม.ย.': '04', 'เม.ย': '04',
  'พ.ค.': '05', 'พ.ค': '05',
  'มิ.ย.': '06', 'มิ.ย': '06',
  'ก.ค.': '07', 'ก.ค': '07',
  'ส.ค.': '08', 'ส.ค': '08',
  'ก.ย.': '09', 'ก.ย': '09',
  'ต.ค.': '10', 'ต.ค': '10',
  'พ.ย.': '11', 'พ.ย': '11',
  'ธ.ค.': '12', 'ธ.ค': '12'
};

function thaiDigitsToArabic(str) {
  const map = { '๐': '0', '๑': '1', '๒': '2', '๓': '3', '๔': '4', '๕': '5', '๖': '6', '๗': '7', '๘': '8', '๙': '9' };
  return str.replace(/[๐-๙]/g, d => map[d]);
}

function parseThaiDate(thaiDate) {
  const parts = thaiDate.split(/\s+/);
  if (parts.length < 3) return null;
  const [dayThai, monThai, yearThai] = parts;
  const dayB = thaiDigitsToArabic(dayThai).padStart(2, '0');
  const monB = thaiMonths[monThai] || '00';
  const buddhistYear = parseInt(thaiDigitsToArabic(yearThai), 10);
  const yearG = buddhistYear - 543;
  return `${yearG}-${monB}-${dayB}`;
}

const CATEGORY_MAP = {
  "1": "รัฐธรรมนูญ",
  "2": "พระราชบัญญัติ",
  "3": "พระราชกำหนด",
  "4": "พระราชกฤษฎีกา",
  "5": "กฎกระทรวงและอื่นๆ"
};

const VALID_TOKEN = '9d1a78a0-2e31-4ee6-b2b6-d1ea3e8f7c4a';

function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid Authorization header' });
  }
  const token = authHeader.split(' ')[1];
  if (token !== VALID_TOKEN) {
    return res.status(403).json({ error: 'Forbidden: Invalid token' });
  }
  next();
}

app.get('/api/search', authMiddleware, async (req, res) => {
  let browser = null;
  try {
    const { category, 'date-from': dateFrom, 'date-to': dateTo } = req.query;
    if (!category) {
      return res.status(400).json({ error: 'ต้องระบุพารามิเตอร์ category (1-5)' });
    }
    const categoryName = CATEGORY_MAP[category];
    if (!categoryName) {
      return res.status(400).json({ error: 'category ต้องเป็น 1-5 เท่านั้น' });
    }

    // launch browser "new"
    browser = await puppeteer.launch({
      headless: "new",
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    // disable timeouts
    page.setDefaultNavigationTimeout(0);
    page.setDefaultTimeout(0);

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    await page.setViewport({ width: 1280, height: 800 });

    // go to search page
    await page.goto('https://ratchakitcha.soc.go.th/search-result', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#search-result', { visible: true });

    // switch to tab2
    await page.click('#search2-tab');
    await page.waitForSelector('#search2', { visible: true });

    // select category checkbox
    await page.evaluate(cat => {
      document.querySelectorAll('input[name="sub-category[]"]').forEach(cb => {
        const label = cb.nextElementSibling?.textContent?.trim() || '';
        if (label.includes(cat)) {
          if (!cb.checked) cb.click();
        } else if (cb.checked) {
          cb.click();
        }
      });
    }, categoryName);

    // fill dates if given
    await page.evaluate((from, to) => {
      const f = document.getElementById('search2-date-from');
      const t = document.getElementById('search2-date-to');
      if (f && from) {
        f.value = from;
        f.dispatchEvent(new Event('input', { bubbles: true }));
        f.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (t && to) {
        t.value = to;
        t.dispatchEvent(new Event('input', { bubbles: true }));
        t.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, dateFrom, dateTo);

    // click search
    await page.click('#btn-search2');
    await page.waitForNavigation({ waitUntil: 'domcontentloaded' });

    // no result?
    try {
      await page.waitForSelector('.post-thumbnail-entry', { timeout: 5000 });
    } catch {
      await browser.close();
      return res.status(404).json({ status: 404, error: 'ไม่พบข้อมูล' });
    }

    // pagination loop
    const rkjs = [];

    while (true) {
      let foundEntry = false;
      try {
        await page.waitForSelector('.post-thumbnail-entry', { timeout: 10000 });
        foundEntry = true;
      } catch (e) {
        // เจอหน้าว่างหรือโหลดช้าเกินไป
        break;
      }

      if (!foundEntry) break;

      // await page.waitForSelector('.post-thumbnail-entry');
      const html = await page.content();
      const $ = cheerio.load(html);

      $('.post-thumbnail-entry').each((i, el) => {
        const $el = $(el);
        const doctitle = $el.find('a.m-b-10').text().trim();
        const filePath = $el.find('a.m-b-10').attr('href');
        const rawDate = $el.find('span.post-date').text().trim();
        const publishDate = rawDate ? parseThaiDate(rawDate) : null;
        const catText = $el.find('span.post-category').map((_, e) => $(e).text().trim()).get().join(' ');
        const m = catText.match(/เล่ม\s*([๐-๙]+)\s*ตอน(?:ที่)?\s*(พิเศษ)?\s*([๐-๙]+)\s*([ก-ฮ])?\s*(?:หน้า\s*([๐-๙]+))?/u);
        let bookNo = null, section = null, pageNo = null;
        if (m) {
          bookNo = thaiDigitsToArabic(m[1]);
          pageNo = m[5] ? thaiDigitsToArabic(m[5]) : null;
          const parts = [thaiDigitsToArabic(m[3])];
          if (m[4]) parts.push(m[4]);
          if (m[2]) parts.push(m[2]);
          section = parts.join(' ');
        }
        rkjs.push({ no: rkjs.length + 1, doctitle, bookNo, section, publishDate, pageNo, filePath });
      });

      // 1) ลองหาเลขหน้าถัดไป block เลข
      let nextLink = await page.$(
        'ul.pagination li.page-item.current + li.page-item:not(.hidden) a.page-numbers'
      );

      // 2) ถ้ายังไม่เจอ ให้หา <a> ที่มีข้อความ "ถัดไป" ด้วย XPath ผ่าน evaluateHandle
      if (!nextLink) {
        const handle = await page.evaluateHandle(() => {
          const xpath = '//ul[contains(@class,"pagination")]//a[normalize-space(text())="ถัดไป"]';
          const result = document.evaluate(
            xpath, document, null,
            XPathResult.FIRST_ORDERED_NODE_TYPE, null
          );
          const a = result.singleNodeValue;
          // เช็คว่า li ที่ครอบ a มี class "hidden"
          if (a && a.parentElement && a.parentElement.classList.contains('hidden')) {
            return null; // ไม่ควรคลิก
          }
          return a;
        });
        nextLink = handle.asElement();
      }

      // 3) ถ้ายังหาไม่เจอ แปลว่าหมดแล้ว ก็จบ
      if (!nextLink) break;

      // 4) คลิกแล้วรอโหลดหน้าใหม่
      await Promise.all([
        page.evaluate(el => el.click(), nextLink),
        page.waitForNavigation({ waitUntil: 'domcontentloaded' })
      ]);
    }

    await browser.close();
    return res.json({ status: 200, totalItem: rkjs.length, rkjs });
  }
  catch (err) {
    if (browser) {
      try { await browser.close(); } catch { }
    }
    console.error(err);
    return res.status(500).json({ error: 'เกิดข้อผิดพลาดจากฝั่งเซิร์ฟเวอร์', detail: err.message });
  }
});


app.get('/api/search1', authMiddleware, async (req, res) => {
  let browser = null;
  try {
    console.log('QUERY:', req.query);

    const { title, type, bookNo, part, partExtra, dateBegin, dateEnd, searchField } = req.query;
    if (!title && !type && !bookNo && !part && !partExtra && !dateBegin && !dateEnd) {
      return res.status(400).json({ error: 'กรุณาระบุอย่างน้อยหนึ่งพารามิเตอร์ เช่น ?title=...' });
    }

    browser = await puppeteer.launch({
      // launch browser "new"
      headless: "new",
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    await page.setViewport({ width: 1280, height: 800 });

    await page.goto('https://ratchakitcha.soc.go.th/search-result', { waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.waitForSelector('#search-result', { visible: true, timeout: 10000 });

    // กรอกฟอร์ม/ติ๊ก checkbox/ใส่วันที่
    if (title) {
      await page.focus('#search-keyword');
      await page.$eval('#search-keyword', el => el.value = '');
      await page.type('#search-keyword', title);
    }
    if (bookNo) {
      await page.focus('input[name="book"]');
      await page.$eval('input[name="book"]', el => el.value = '');
      await page.type('input[name="book"]', bookNo);
    }
    if (part) {
      await page.focus('input[name="session"]');
      await page.$eval('input[name="session"]', el => el.value = '');
      await page.type('input[name="session"]', part);
    }
    if (type) {
      const types = Array.isArray(type) ? type : [type];
      for (const t of types) {
        await page.evaluate((v) => {
          const chk = [...document.querySelectorAll('input[name="type[]"]')].find(x => x.value === v);
          if (chk && !chk.checked) chk.click();
        }, t);
      }
    }
    await page.evaluate((from, to) => {
      const fromEl = document.getElementById('search1-date-from');
      if (fromEl) {
        fromEl.value = from;
        fromEl.dispatchEvent(new Event('input', { bubbles: true }));
        fromEl.dispatchEvent(new Event('change', { bubbles: true }));
        fromEl.blur();
      }
      const toEl = document.getElementById('search1-date-to');
      if (toEl) {
        toEl.value = to;
        toEl.dispatchEvent(new Event('input', { bubbles: true }));
        toEl.dispatchEvent(new Event('change', { bubbles: true }));
        toEl.blur();
      }
    }, dateBegin, dateEnd);
    await page.click('body');
    await new Promise(r => setTimeout(r, 200));

    await page.evaluate(() => document.querySelector('#btn-search1').click());
    await page.waitForNavigation({ waitUntil: 'domcontentloaded' });

    // --- วนลูปทุกหน้า ---
    const rkjs = [];
    while (true) {
      // ถ้าไม่เจอ selector ภายใน 10 วิ ให้ออก loop (กันเจอหน้าว่าง)
      let foundEntry = false;
      try {
        await page.waitForSelector('.post-thumbnail-entry', { timeout: 10000 });
        foundEntry = true;
      } catch (e) {
        break;
      }
      if (!foundEntry) break;

      const html = await page.content();
      const $ = cheerio.load(html);
      $('.post-thumbnail-entry').each((i, el) => {
        const $el = $(el);
        const doctitle = $el.find('a.m-b-10').text().trim();
        const filePath = $el.find('a.m-b-10').attr('href');
        const rawDate = $el.find('span.post-date').text().trim();
        const publishDate = rawDate ? parseThaiDate(rawDate) : null;
        const catText = $el.find('span.post-category').toArray().map(e => $(e).text().trim()).join(' ');

        let bookNo = null, section = null, pageNo = null, category = null;

        // --- กรณี 1: ปี 2451 ลงไป (เช่น "เล่ม 25 ตอนที่ 39 หน้า 1141")
        let m = catText.match(/เล่ม\s*([๐-๙]+)\s*ตอน(?:ที่)?\s*([๐-๙]+)\s*หน้า\s*([๐-๙]+)/u);
        if (m) {
          bookNo = thaiDigitsToArabic(m[1]);
          section = thaiDigitsToArabic(m[2]);
          category = null;
          pageNo = thaiDigitsToArabic(m[3]);
        } else {
          // --- กรณี 2: ปี 2452-2484 (เช่น "เล่ม 26 ก หน้า 103")
          m = catText.match(/เล่ม\s*([๐-๙]+)\s*([ก-ฮ])\s*หน้า\s*([๐-๙]+)/u);
          if (m) {
            bookNo = thaiDigitsToArabic(m[1]);
            section = null;
            category = m[2];
            pageNo = thaiDigitsToArabic(m[3]);
          } else {
            let m = catText.match(/เล่ม\s*([๐-๙]+)\s*ตอน(?:ที่)?\s*(พิเศษ)?\s*([๐-๙]+)\s*([ก-ฮ])?\s*หน้า\s*([๐-๙]+)/u);
            if (m) {
              // 1. แบบปี 2485 ขึ้นไป ("พิเศษ" กับตัวอักษรอาจสลับลำดับกัน)
              bookNo = thaiDigitsToArabic(m[1]);
              section = thaiDigitsToArabic(m[3]);
              pageNo = thaiDigitsToArabic(m[5]);
              // ** ดึงตัวอักษร ก-ฮ กับ "พิเศษ" รวมกัน
              let catArr = [];
              if (m[4]) catArr.push(m[4].trim());      // ง
              if (m[2]) catArr.push(m[2].trim());      // พิเศษ
              category = catArr.length ? catArr.join(' ') : null;
            } else {
              // ไม่เข้า pattern ไหนเลย
              bookNo = null;
              section = null;
              category = null;
              pageNo = null;
            }
          }
        }

        rkjs.push({
          no: rkjs.length + 1,
          doctitle,
          bookNo,
          section,
          category,
          publishDate,
          pageNo,
          filePath
        });
      });

      // pagination: click next page number or "ถัดไป"
      let nextLink = await page.$('ul.pagination li.page-item.current + li.page-item:not(.hidden) a.page-numbers');
      if (!nextLink) {
        const handle = await page.evaluateHandle(() => {
          const xpath = '//ul[contains(@class,"pagination")]//a[normalize-space(text())="ถัดไป"]';
          const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          const a = result.singleNodeValue;
          if (a && a.parentElement && a.parentElement.classList.contains('hidden')) return null;
          return a;
        });
        nextLink = handle.asElement();
      }
      if (!nextLink) break;
      await Promise.all([
        page.evaluate(el => el.click(), nextLink),
        page.waitForNavigation({ waitUntil: 'domcontentloaded' })
      ]);
    }

    await browser.close();
    res.json({ status: 200, totalItem: rkjs.length, rkjs });

  } catch (err) {
    if (browser) try { await browser.close(); } catch { }
    console.error(err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดจากฝั่งเซิร์ฟเวอร์', detail: err.message });
  }
});


app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
