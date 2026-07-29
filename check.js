/* QA-прогон приложения: доменная логика, UI-сценарии, надёжность данных, аудит */
const { chromium } = require('playwright');
const path = require('path');
const fsx = require('fs');
const APP = ['Журнал репетитора.html', 'index.html']
  .map(f => path.join(__dirname, f)).find(f => fsx.existsSync(f));
const URL = 'file://' + encodeURI(APP);

let pass = 0, fail = 0;
const t = (name, ok, extra = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? '  — ' + extra : ''}`);
};

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ru-RU' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(URL);
  await page.waitForTimeout(400);

  /* ───── 0. Первый запуск ───── */
  console.log('── Первый запуск ──');
  t('первый запуск показывает приветствие', await page.locator('#welcome').isVisible());
  t('до выбора ничего не сохранено', await page.evaluate(() =>
    localStorage.getItem('tutor-journal-v3') === null));
  await page.locator('#w-demo').click(); await page.waitForTimeout(400);
  t('пример данных загружается', await page.evaluate(() =>
    window.__journal.data.students.length === 10));
  t('после выбора данные сохранены', await page.evaluate(() =>
    localStorage.getItem('tutor-journal-v3') !== null));

  /* ───── 1. Сид и инварианты баланса ───── */
  console.log('\n── Баланс и FIFO ──');
  const expect = { 'Миша Орлов': 0, 'Аня Северова': 1, 'Пётр Дубов': -2, 'Катя Лунина': 7,
                   'Даня Ким': 4, 'Лиза Ворон': 3, 'Тимур Ясин': 9, 'Оля Гринь': 1,
                   'Игорь Соловьёв': 0, 'Мария Лант': 2 };
  const res = await page.evaluate(() => window.__journal.data.students.map(s => {
    const c = window.__journal.calc(s.id);
    return { name: s.name, balance: c.balance, left: c.leftInCurrent, pkgSize: c.current ? c.current.lessons : 0,
             bought: c.totalBought, consumed: c.totalConsumed, level: c.level,
             sumUsed: c.used.reduce((a, b) => a + b, 0), nPkg: c.pkgs.length };
  }));
  for (const r of res) {
    const ok = r.balance === expect[r.name]
      && r.bought - r.consumed === r.balance
      && r.sumUsed === Math.min(r.consumed, r.bought)
      && (r.balance < 0 || r.left === Math.min(r.balance, r.pkgSize));
    t(`${r.name.padEnd(13)} баланс ${String(r.balance).padStart(3)}, ${r.left}/${r.pkgSize}, пакетов ${r.nPkg}, ${r.level}`, ok);
  }
  t('есть ученик с предупреждением, нулём и долгом',
    res.some(r => r.level === 'warn') && res.some(r => r.level === 'zero') && res.some(r => r.level === 'debt'));

  /* ───── 2. Статусы ───── */
  console.log('\n── Статусы занятий ──');
  const scen = await page.evaluate(() => {
    const j = window.__journal, out = [];
    const s = j.data.students.find(x => x.name === 'Катя Лунина');
    const d = '2026-09-15';               // будущая дата: сид туда не дотягивается
    const base = j.calc(s.id).balance;
    const step = (st, want, label) => { j.setStatus(s.id, d, st); out.push([label, j.calc(s.id).balance === want]); };
    step('held', base - 1, 'проведён списывает урок');
    step('cancelled_free', base, 'отмена вовремя не списывает');
    step('cancelled_late', base - 1, 'поздняя отмена списывает');
    step('no_show', base - 1, 'неявка списывает');
    step('rescheduled', base, 'перенос не списывает');
    step('planned', base, 'запланированный не списывает');
    step(null, base, 'очистка возвращает урок');
    return out;
  });
  scen.forEach(([n, ok]) => t(n, ok));

  /* ───── 3. Граничные случаи ───── */
  console.log('\n── Граничные случаи ──');
  const edge = await page.evaluate(() => {
    const j = window.__journal, out = [];
    // ученик без пакетов
    const id = 900001;
    j.commit({ kind: 'student', key: String(id), value: { id, name: 'Тест Пустой', contact: '', currency: 'RUB',
      defaultPrice: 100, defaultPackage: 8, warnAt: null, notes: '', archived: 0, order: 99, createdAt: Date.now() } },
      { kind: 'student', studentId: id, title: 'Добавлен ученик: Тест Пустой', sub: '' });
    j.setStatus(id, '2026-07-20', 'held');
    let c = j.calc(id);
    out.push(['ученик без пакетов уходит в долг, расчёт не падает', c.balance === -1 && c.leftInCurrent === 0 && c.level === 'debt']);
    // пакет с 0 уроков
    j.commit({ kind: 'package', key: '900002', value: { id: 900002, studentId: id, purchasedOn: '2026-07-01',
      lessons: 0, pricePerLesson: 0, currency: 'RUB', comment: '', createdAt: Date.now() } },
      { kind: 'package', studentId: id, title: 'Оплата: 0 уроков', sub: '' });
    c = j.calc(id);
    out.push(['пакет на 0 уроков не ломает расчёт', c.balance === -1 && Number.isFinite(c.leftInCurrent)]);
    // покупка до исчерпания старого пакета (два активных пакета)
    j.commit({ kind: 'package', key: '900003', value: { id: 900003, studentId: id, purchasedOn: '2026-07-02',
      lessons: 5, pricePerLesson: 100, currency: 'RUB', comment: '', createdAt: Date.now() } },
      { kind: 'package', studentId: id, title: 'Оплата: 5 уроков', sub: '' });
    c = j.calc(id);
    out.push(['FIFO: урок списан из старого пакета, новый цел', c.balance === 4 && c.leftInCurrent === 4]);
    // изменение даты занятия задним числом
    j.setStatus(id, '2026-05-11', 'held');
    c = j.calc(id);
    out.push(['занятие задним числом уменьшает баланс', c.balance === 3]);
    // повторная установка того же статуса не плодит дублей
    j.setStatus(id, '2026-05-11', 'held');
    out.push(['повторная отметка не создаёт дубль ячейки',
      j.data.lessons.filter(l => l.studentId === id && l.date === '2026-05-11').length === 1]);
    return out;
  });
  edge.forEach(([n, ok]) => t(n, ok));

  /* ───── 4. Отмена, возврат, аудит ───── */
  console.log('\n── Отмена, возврат и журнал изменений ──');
  const hist = await page.evaluate(() => {
    const j = window.__journal, out = [];
    j.reset();
    const s = j.data.students.find(x => x.name === 'Катя Лунина');
    const before = j.calc(s.id).balance;
    const n0 = j.data.audit.length;
    j.setStatus(s.id, '2026-09-22', 'held');
    out.push(['изменение попало в журнал', j.data.audit.length === n0 + 1]);
    out.push(['в записи журнала есть время', typeof j.data.audit[0].ts === 'number' && j.data.audit[0].ts > 0]);
    out.push(['в записи журнала есть ученик', j.data.audit[0].studentId === s.id]);
    j.undo();
    out.push(['undo вернул баланс', j.calc(s.id).balance === before]);
    out.push(['undo сам попал в журнал (append-only)', j.data.audit.length === n0 + 2 && j.data.audit[0].kind === 'undo']);
    j.redo();
    out.push(['redo повторил действие', j.calc(s.id).balance === before - 1]);
    // откат конкретной записи из середины истории
    j.setStatus(s.id, '2026-09-23', 'held');
    j.setStatus(s.id, '2026-09-24', 'held');
    const target = j.data.audit.find(a => a.kind === 'lesson' && a.sub && a.sub.startsWith('22.09'));
    j.revertEntry(target.id);
    const cells = ['2026-09-22', '2026-09-23', '2026-09-24'].map(d =>
      !!j.data.lessons.find(l => l.studentId === s.id && l.date === d));
    out.push(['откат записи из середины журнала снял только её', !cells[0] && cells[1] && cells[2]]);
    out.push(['глубина undo растёт', j.undoDepth > 0]);
    j.reset();
    return out;
  });
  hist.forEach(([n, ok]) => t(n, ok));

  /* ───── 5. UI-сценарии ───── */
  console.log('\n── Интерфейс ──');
  await page.reload(); await page.waitForTimeout(300);

  // клик по ячейке
  const cell = page.locator('td.day').nth(3);
  const sid = await cell.getAttribute('data-s'), cdate = await cell.getAttribute('data-d');
  const b1 = await page.evaluate(s => window.__journal.calc(+s).balance, sid);
  await cell.click(); await page.waitForTimeout(120);
  const b2 = await page.evaluate(s => window.__journal.calc(+s).balance, sid);
  t('клик по ячейке отмечает занятие и списывает урок', b2 === b1 - 1);
  await cell.click(); await page.waitForTimeout(120);
  const b3 = await page.evaluate(s => window.__journal.calc(+s).balance, sid);
  t('повторный клик снимает отметку и возвращает урок', b3 === b1);

  // контекстное меню
  await cell.click({ button: 'right' }); await page.waitForTimeout(150);
  t('контекстное меню открывается', await page.locator('#menu').isVisible());
  t('в меню видно имя и дату', (await page.locator('#menu .mhead').innerText()).includes('.'));
  await page.locator('#menu div[data-a="Отменён вовремя"]').click(); await page.waitForTimeout(120);
  const st1 = await page.evaluate(([s, d]) => {
    const l = window.__journal.data.lessons.find(x => x.studentId === +s && x.date === d);
    return l && l.status;
  }, [sid, cdate]);
  t('статус из меню применяется', st1 === 'cancelled_free');

  // заметка через своё окно (без window.prompt)
  await cell.click({ button: 'right' }); await page.waitForTimeout(120);
  await page.locator('#menu div[data-a*="заметку"]').click(); await page.waitForTimeout(150);
  await page.locator('#nt').fill('проверка заметки');
  await page.locator('[data-x=s]').click(); await page.waitForTimeout(150);
  t('заметка сохраняется', await page.evaluate(([s, d]) =>
    window.__journal.data.lessons.find(x => x.studentId === +s && x.date === d).note === 'проверка заметки', [sid, cdate]));
  t('ячейка с заметкой помечена уголком', await page.locator(`td[data-s="${sid}"][data-d="${cdate}"].hasnote`).count() === 1);

  // клавиатура
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(100);
  await page.keyboard.press('1'); await page.waitForTimeout(120);
  t('клавиатура: стрелка + цифра ставят статус', await page.evaluate(s =>
    window.__journal.data.lessons.some(l => l.studentId === +s && l.status === 'held'), sid));
  await page.keyboard.press('Backspace'); await page.waitForTimeout(120);
  await page.keyboard.press('Control+z'); await page.waitForTimeout(150);
  t('Ctrl+Z работает с клавиатуры', await page.evaluate(() => window.__journal.redoDepth > 0));

  // оплата через UI
  await page.locator('#addPayment').click(); await page.waitForTimeout(200);
  const stSel = await page.locator('#p-st').inputValue();
  const balBefore = await page.evaluate(s => window.__journal.calc(+s).balance, stSel);
  await page.locator('#p-n').fill('12');
  await page.locator('[data-x=s]').click(); await page.waitForTimeout(200);
  const balAfter = await page.evaluate(s => window.__journal.calc(+s).balance, stSel);
  t('оплата через окно увеличивает баланс на 12', balAfter === balBefore + 12);
  t('после оплаты показан тост', await page.locator('.toast').count() > 0);
  t('оплата записана в журнал', await page.evaluate(() =>
    window.__journal.data.audit[0].kind === 'package'));

  // главная страница: накопленный баланс и быстрые действия
  const katRow = page.locator('td.namecell:has-text("Катя Лунина")');
  await page.evaluate(() => {
    const j = window.__journal;
    const s = j.data.students.find(x => x.name === 'Катя Лунина');
    j.commit({kind:'package', key:'910001', value:{id:910001, studentId:s.id,
      purchasedOn:'2026-07-25', lessons:10, pricePerLesson:1800, currency:'RUB',
      comment:'тест накопления', createdAt:Date.now()}},
      {kind:'package', studentId:s.id, title:'Оплата: Катя Лунина — 10 уроков', sub:''});
  });
  await page.waitForTimeout(200);
  const katBal = await page.evaluate(() => {
    const j = window.__journal;
    return j.calc(j.data.students.find(x => x.name === 'Катя Лунина').id).balance;
  });
  t('баланс копится сверх размера пакета', katBal === 17);
  t('в строке ученика виден общий накопленный баланс',
    (await katRow.locator('.balnum').innerText()) === '17');
  t('в строке видны уроки за месяц и дата оплаты',
    /мес:/.test(await katRow.innerText()) && /опл\./.test(await katRow.innerText()));

  await katRow.hover(); await page.waitForTimeout(150);
  t('при наведении на строку появляется кнопка оплаты', await katRow.locator('.qpay').isVisible());
  await katRow.locator('.qpay').click(); await page.waitForTimeout(200);
  const qsel = await page.locator('#p-st option:checked').innerText();
  t('быстрая оплата открывается с нужным учеником', qsel === 'Катя Лунина');
  await page.keyboard.press('Escape'); await page.waitForTimeout(150);

  // удаление оплаты из карточки
  await katRow.click(); await page.waitForTimeout(300);
  t('у пакетов в карточке есть кнопка удаления', await page.locator('[data-delpkg]').count() >= 2);
  await page.locator('[data-delpkg="910001"]').click(); await page.waitForTimeout(200);
  t('удаление оплаты просит подтверждения', await page.locator('.modal:has-text("Удалить оплату")').isVisible());
  await page.locator('[data-x=yes]').click(); await page.waitForTimeout(300);
  const afterDel = await page.evaluate(() => {
    const j = window.__journal;
    return {bal:j.calc(j.data.students.find(x => x.name === 'Катя Лунина').id).balance,
            audit:j.data.audit[0].title};
  });
  t('удаление оплаты пересчитывает баланс', afterDel.bal === 7);
  t('удаление оплаты записано в журнал', afterDel.audit.includes('Оплата удалена'));
  await page.keyboard.press('Escape'); await page.waitForTimeout(150);
  await page.evaluate(() => { window.__journal.undo(); window.__journal.undo(); });
  await page.waitForTimeout(150);
  t('оба действия с оплатой откатываются', await page.evaluate(() => {
    const j = window.__journal;
    return j.calc(j.data.students.find(x => x.name === 'Катя Лунина').id).balance === 7
      && !j.data.packages.some(p => p.id === 910001);
  }));

  // сумма пакета пересчитывается из цены
  await page.locator('#addPayment').click(); await page.waitForTimeout(150);
  await page.locator('#p-price').fill('1000'); await page.locator('#p-n').fill('7');
  await page.waitForTimeout(80);
  t('сумма пакета пересчитывается', await page.locator('#p-total').inputValue() === '7000');
  await page.locator('#p-total').fill('14000'); await page.waitForTimeout(80);
  t('цена пересчитывается из суммы', await page.locator('#p-price').inputValue() === '2000');
  await page.keyboard.press('Escape'); await page.waitForTimeout(120);
  t('Escape закрывает окно', await page.locator('.overlay').count() === 0);

  // валидация: оплата без уроков
  await page.locator('#addPayment').click(); await page.waitForTimeout(150);
  await page.locator('#p-n').fill('0');
  await page.locator('[data-x=s]').click(); await page.waitForTimeout(150);
  t('оплата на 0 уроков не сохраняется', await page.locator('.overlay').count() === 1);
  await page.keyboard.press('Escape'); await page.waitForTimeout(100);

  // новый ученик через UI
  const cnt0 = await page.evaluate(() => window.__journal.data.students.length);
  await page.locator('#addStudent').click(); await page.waitForTimeout(150);
  await page.locator('[data-x=s]').click(); await page.waitForTimeout(120);
  t('ученик без имени не добавляется', await page.evaluate(() => window.__journal.data.students.length) === cnt0);
  await page.locator('#n-name').fill('Новый Ученик');
  await page.locator('#n-price').fill('1700');
  await page.locator('[data-x=s]').click(); await page.waitForTimeout(200);
  t('ученик добавляется через окно', await page.evaluate(() =>
    window.__journal.data.students.some(s => s.name === 'Новый Ученик')));
  t('новый ученик появился в сетке', await page.locator('td.namecell:has-text("Новый Ученик")').count() === 1);

  // карточка ученика
  await page.locator('td.namecell:has-text("Новый Ученик")').click(); await page.waitForTimeout(200);
  t('карточка ученика открывается', await page.locator('.drawer').isVisible());
  await page.locator('#f-price').fill('2100');
  await page.locator('#b-save').click(); await page.waitForTimeout(200);
  t('изменение цены сохраняется', await page.evaluate(() =>
    window.__journal.data.students.find(s => s.name === 'Новый Ученик').defaultPrice === 2100));
  t('изменение карточки попало в журнал с расшифровкой', await page.evaluate(() =>
    window.__journal.data.audit[0].kind === 'student' && window.__journal.data.audit[0].sub.includes('цена')));

  // архив
  await page.locator('td.namecell:has-text("Новый Ученик")').click(); await page.waitForTimeout(200);
  await page.locator('#b-arch').click(); await page.waitForTimeout(150);
  t('архивация просит подтверждения', await page.locator('.modal').isVisible());
  await page.locator('[data-x=yes]').click(); await page.waitForTimeout(250);
  t('архивный ученик исчезает из сетки', await page.locator('td.namecell:has-text("Новый Ученик")').count() === 0);
  t('история архивного ученика сохранилась', await page.evaluate(() =>
    window.__journal.data.students.some(s => s.name === 'Новый Ученик')));

  // журнал изменений
  await page.locator('#history').click(); await page.waitForTimeout(250);
  t('журнал изменений открывается', await page.locator('.drawer:has-text("Журнал изменений")').isVisible());
  const logRows = await page.locator('.drawer .logrow').count();
  t('в журнале есть записи', logRows > 5, `${logRows} записей`);
  t('в журнале видно время', /\d{2}:\d{2}/.test(await page.locator('.drawer .logrow .time').first().innerText()));
  const revBtns = await page.locator('.drawer [data-rev]').count();
  t('у записей есть кнопка «Вернуть»', revBtns > 0);
  await page.locator('.drawer [data-rev]').first().click({ force: true }); await page.waitForTimeout(300);
  t('откат из журнала выполняется и журнал остаётся открыт',
    await page.locator('.drawer:has-text("Журнал изменений")').count() === 1);
  await page.keyboard.press('Escape'); await page.waitForTimeout(150);

  // поиск и навигация
  await page.locator('#search').fill('катя'); await page.waitForTimeout(200);
  t('поиск фильтрует по имени без учёта регистра', await page.locator('tbody tr').count() === 1);
  await page.locator('#search').fill('ззз'); await page.waitForTimeout(200);
  t('пустой результат показывает подсказку', await page.locator('.empty').isVisible());
  await page.locator('#search').fill(''); await page.waitForTimeout(200);

  const m0 = await page.locator('#monthLabel').innerText();
  await page.locator('#prev').click(); await page.waitForTimeout(150);
  const m1 = await page.locator('#monthLabel').innerText();
  await page.locator('#today').click(); await page.waitForTimeout(150);
  t('переключение месяцев работает', m0 !== m1 && (await page.locator('#monthLabel').innerText()) === m0);

  // 31-е число не теряется при переходе месяцев
  await page.evaluate(() => window.__journal.setView('2026-01-31'));
  await page.locator('#next').click(); await page.waitForTimeout(120);
  t('переход с 31 января ведёт в февраль, а не в март',
    (await page.locator('#monthLabel').innerText()).startsWith('февраль'));
  await page.locator('#today').click(); await page.waitForTimeout(150);

  /* ───── 5б. Финансовый монитор ───── */
  console.log('\n── Финансовый монитор ──');
  await page.evaluate(() => window.__journal.reset());
  await page.waitForTimeout(200);
  await page.locator('#tabs [data-m=money]').click(); await page.waitForTimeout(400);
  t('экран финансов открывается', await page.locator('.page:has-text("Финансовый монитор")').isVisible());
  const tiles = await page.locator('.tile').count();
  t('показаны сводные показатели', tiles >= 6, `${tiles} плиток`);
  const charts = await page.locator('.chart svg').count();
  t('графики по месяцам построены', charts === 3, `${charts} графика`);
  t('на графике есть подписи оси', await page.locator('.chart .tick').count() > 5);
  t('столбцы — отдельные фигуры с подсказкой',
    await page.locator('.chart .bar[data-tip]').count() > 5);
  t('под графиками есть таблица с теми же числами',
    await page.locator('.card:has-text("По месяцам") table.data').isVisible());
  t('есть разбивка по ученикам',
    await page.locator('.card:has-text("Вклад учеников") table.data tbody tr').count() > 5);

  // суммы в таблице сходятся с расчётом
  const agree = await page.evaluate(() => {
    const j = window.__journal;
    const rows = j.monthlyStats(null);
    const sum = k => rows.reduce((s, r) => s + r[k], 0);
    // «отработано» за всё время = сумма по ученикам
    let earn = 0;
    j.data.students.forEach(s => { const m = j.metrics(s.id); if (s.currency === 'RUB') earn += m.earned; });
    return { tableRUB: Math.round(sum('earnRUB')), byStudent: Math.round(earn),
             hours: Math.round(sum('hours')), lessons: sum('lessons') };
  });
  t('помесячные суммы сходятся с суммами по ученикам', agree.tableRUB === agree.byStudent,
    `${agree.tableRUB} ₽`);
  t('часы посчитаны', agree.hours > 100, `${agree.hours} ч за всё время`);

  // переключение глубины периода
  const rows12 = await page.evaluate(() => window.__journal.monthlyStats(null).length);
  await page.locator('[data-range="6"]').click(); await page.waitForTimeout(300);
  const barsAfter = await page.locator('.chart').first().locator('.bar').count();
  t('период 6 месяцев сужает график', barsAfter <= 6, `${barsAfter} столбцов`);
  await page.locator('[data-range="0"]').click(); await page.waitForTimeout(300);
  const barsAll = await page.locator('.chart').first().locator('.bar').count();
  t('период «всё время» показывает всю историю', barsAll > barsAfter && barsAll <= rows12,
    `${barsAll} месяцев`);
  t('в шапке периода написано «всё время»',
    (await page.locator('.pagehead .dsub').innerText()).includes('всё время'));
  await page.locator('[data-range="12"]').click(); await page.waitForTimeout(300);
  await page.screenshot({ path: '/root/tutor-app/shot-6-money.png' });

  // подсказка на графике
  await page.locator('.chart .bar').first().hover(); await page.waitForTimeout(200);
  t('подсказка над столбцом появляется',
    await page.locator('.viztip').first().evaluate(e => getComputedStyle(e).opacity === '1'));

  /* ───── 5в. Архив и метрика по ученикам ───── */
  console.log('\n── Архив учеников ──');
  await page.locator('#tabs [data-m=archive]').click(); await page.waitForTimeout(400);
  t('экран архива открывается', await page.locator('.page:has-text("Архив учеников")').isVisible());
  const archRows = await page.locator('table.data tbody tr').count();
  t('в архиве есть ученики из тестовых данных', archRows === 2, `${archRows} ученика`);
  t('нет календарной сетки', await page.locator('td.day').count() === 0);
  const headers = await page.locator('table.data thead th').allInnerTexts();
  ['Период занятий', 'Уроков', 'Часов', 'Отмен', 'Оплачено', 'Заработано', 'Остаток']
    .forEach(h => t(`колонка «${h}» на месте`, headers.some(x => x.includes(h))));
  t('метрика заполнена, а не прочерки',
    !(await page.locator('table.data tbody tr').first().innerText()).includes('———'));

  await page.locator('[data-scope="all"]').click(); await page.waitForTimeout(300);
  t('переключение на всех учеников работает',
    await page.locator('table.data tbody tr').count() === 10);
  await page.screenshot({ path: '/root/tutor-app/shot-7-people.png' });
  await page.locator('[data-scope="archive"]').click(); await page.waitForTimeout(300);

  // возврат из архива
  const activeBefore = await page.evaluate(() =>
    window.__journal.data.students.filter(s => !s.archived).length);
  await page.locator('[data-unarch]').first().click(); await page.waitForTimeout(300);
  t('кнопка «Вернуть» возвращает ученика в сетку', await page.evaluate(() =>
    window.__journal.data.students.filter(s => !s.archived).length) === activeBefore + 1);
  t('возврат из архива попал в журнал', await page.evaluate(() =>
    window.__journal.data.audit[0].title.includes('из архива')));
  await page.evaluate(() => window.__journal.undo()); await page.waitForTimeout(200);
  t('возврат из архива откатывается', await page.evaluate(() =>
    window.__journal.data.students.filter(s => !s.archived).length) === activeBefore);

  // карточка из таблицы
  await page.locator('[data-open]').first().click(); await page.waitForTimeout(300);
  t('карточка открывается из таблицы', await page.locator('.drawer').isVisible());
  t('в карточке есть часы и заработок',
    (await page.locator('.drawer').innerText()).includes('Часов занятий'));
  await page.keyboard.press('Escape'); await page.waitForTimeout(150);

  await page.locator('#tabs [data-m=grid]').click(); await page.waitForTimeout(300);
  t('возврат на сетку работает', await page.locator('td.day').count() > 50);

  /* ───── 6. Автосохранение и восстановление ───── */
  console.log('\n── Автосохранение ──');
  t('в подвале виден статус сохранения', /Сохранен|Автосохранение/.test(await page.locator('.saved').innerText()));
  const snapshot = await page.evaluate(() => ({
    students: window.__journal.data.students.length,
    lessons: window.__journal.data.lessons.length,
    audit: window.__journal.data.audit.length,
  }));
  await page.reload(); await page.waitForTimeout(400);
  const after = await page.evaluate(() => ({
    students: window.__journal.data.students.length,
    lessons: window.__journal.data.lessons.length,
    audit: window.__journal.data.audit.length,
  }));
  t('данные переживают перезагрузку', JSON.stringify(snapshot) === JSON.stringify(after),
    `${after.students} учеников / ${after.lessons} занятий / ${after.audit} записей журнала`);

  // повреждённое хранилище лечится снимком
  await page.evaluate(() => localStorage.setItem('tutor-journal-v3', '{сломано'));
  await page.reload(); await page.waitForTimeout(400);
  t('повреждённое хранилище восстанавливается из снимка', await page.evaluate(() =>
    window.__journal.loadedFrom === 'snapshot' && window.__journal.data.students.length > 0));

  /* ───── 6б. Надёжность данных ───── */
  console.log('\n── Надёжность данных ──');

  // мгновенное сохранение при закрытии
  await page.evaluate(() => { const j = window.__journal;
    j.setStatus(j.data.students[0].id, '2026-06-01', 'held'); j.flushNow(); });
  await page.reload(); await page.waitForTimeout(300);
  t('flushNow сохраняет мгновенно, без ожидания таймера', await page.evaluate(() =>
    window.__journal.data.lessons.some(l => l.date === '2026-06-01')));
  await page.evaluate(() => { const j = window.__journal;
    j.setStatus(j.data.students[0].id, '2026-06-01', null); j.flushNow(); });

  // снимки и восстановление
  const snapTags = await page.evaluate(() => window.__journal.snapshots().map(s => s.tag));
  t('снимки создаются автоматически', snapTags.length >= 1, snapTags.join(', '));
  const restored = await page.evaluate(() => {
    const j = window.__journal;
    j.commit({kind:'student', key:'777777', value:{id:777777, name:'Врем Енный', contact:'',
      currency:'RUB', defaultPrice:100, defaultPackage:8, lessonMinutes:60, warnAt:null,
      notes:'', archived:0, order:50, createdAt:1}},
      {kind:'student', studentId:777777, title:'Добавлен ученик: Врем Енный', sub:''});
    const before = j.data.students.length;
    j.restoreSnapshot(j.snapshots()[0].key);
    return {before, after:j.data.students.length,
            hasTemp:j.data.students.some(s => s.id === 777777),
            trail:j.snapshots().some(s => s.tag === 'before-restore'),
            audit:j.data.audit[0].title.includes('восстановлены')};
  });
  t('восстановление снимка возвращает данные', restored.after === 10 && !restored.hasTemp
    && restored.before === 11);
  t('перед восстановлением создан свой снимок', restored.trail);
  t('восстановление записано в журнал изменений', restored.audit);

  // импорт с предохранителями
  const imp = await page.evaluate(() => {
    const j = window.__journal;
    const d = JSON.parse(JSON.stringify(j.data));
    d.students.push({id:888888, name:'Импорт Тест', contact:'', currency:'USD', defaultPrice:20,
      defaultPackage:8, lessonMinutes:60, warnAt:null, notes:'', archived:0, order:60, createdAt:1});
    j.importData(d);
    return {has:j.data.students.some(s => s.name === 'Импорт Тест'),
            audit:j.data.audit[0].title.includes('Импорт'),
            snap:j.snapshots().some(s => s.tag === 'before-import')};
  });
  t('импорт заменяет данные', imp.has);
  t('импорт записан в журнал', imp.audit);
  t('перед импортом создан снимок', imp.snap);

  // напоминание о резервной копии
  await page.evaluate(() => { const j = window.__journal;
    j.data.settings.lastExportAt = Date.now() - 20 * 86400e3;
    j.data.settings.exportSnoozeUntil = 0; j.persist(); j.render(); });
  t('напоминание о резервной копии появляется', await page.locator('#remind').isVisible());
  await page.locator('#remind [data-later]').click(); await page.waitForTimeout(200);
  t('«Напомнить позже» скрывает напоминание на неделю', await page.locator('#remind').isHidden());

  // одна активная вкладка: синтетика проверяет логику, реальная вкладка — доставку события
  await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage',
    {key:'tutor-journal-tab', newValue:'другая-вкладка'})));
  await page.waitForTimeout(200);
  t('вторая вкладка блокирует первую', await page.locator('#takeover').isVisible());
  await page.locator('#tk').click(); await page.waitForTimeout(200);
  t('«работать в этой вкладке» возвращает контроль',
    await page.locator('#takeover').count() === 0);

  const p2 = await ctx.newPage();
  await p2.goto(URL); await p2.waitForTimeout(500);
  t('вторая копия видит те же данные, а не приветствие', await p2.evaluate(() =>
    window.__journal && window.__journal.data.students.length > 0));
  const realTakeover = await page.locator('#takeover').count() > 0;
  await p2.close(); await page.waitForTimeout(200);
  t('перехват срабатывает и между настоящими вкладками', realTakeover);
  if (realTakeover){ await page.locator('#tk').click(); await page.waitForTimeout(200); }

  t('меню предлагает хранение в файле (Chrome/Edge)', await page.evaluate(() =>
    'showSaveFilePicker' in window ? window.__journal.fileState === 'off' : true));

  /* ───── 7. Экспорт ───── */
  console.log('\n── Экспорт ──');
  const csv = await page.evaluate(() => {
    const j = window.__journal;
    const rows = [['Ученик', 'Дата', 'Статус']];
    j.data.students.forEach(s => j.data.lessons.filter(l => l.studentId === s.id)
      .forEach(l => rows.push([s.name, l.date, l.status])));
    return rows.length;
  });
  t('данные для экспорта собираются', csv > 100, `${csv} строк`);

  /* ───── 8. Темы и разрешения ───── */
  console.log('\n── Оформление ──');
  await page.evaluate(() => window.__journal.reset());
  await page.waitForTimeout(200);
  await page.screenshot({ path: '/root/tutor-app/shot-1-main.png' });

  // пара действий, чтобы на снимке журнала была свежая история
  await page.evaluate(() => {
    const j = window.__journal;
    const k = j.data.students.find(s => s.name === 'Катя Лунина');
    const m = j.data.students.find(s => s.name === 'Миша Орлов');
    j.setStatus(k.id, '2026-07-27', 'held');
    j.setStatus(m.id, '2026-07-24', 'no_show');
    j.undo();
  });
  await page.waitForTimeout(200);
  await page.locator('#history').click(); await page.waitForTimeout(300);
  await page.screenshot({ path: '/root/tutor-app/shot-3-history.png' });
  await page.keyboard.press('Escape'); await page.waitForTimeout(150);

  await page.locator('td.namecell').nth(1).click(); await page.waitForTimeout(300);
  await page.screenshot({ path: '/root/tutor-app/shot-4-student.png' });
  await page.keyboard.press('Escape'); await page.waitForTimeout(150);

  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await page.waitForTimeout(200);
  await page.screenshot({ path: '/root/tutor-app/shot-2-dark.png' });
  await page.evaluate(() => document.documentElement.dataset.theme = 'light');

  const small = await ctx.newPage();
  await small.setViewportSize({ width: 1280, height: 720 });
  await small.goto(URL); await small.waitForTimeout(400);
  const overflow = await small.evaluate(() => {
    const w = document.querySelector('.gridwrap');
    return { scrollW: w.scrollWidth, clientW: w.clientWidth, rows: document.querySelectorAll('tbody tr').length };
  });
  t('на экране 1280×720 сетка помещается по вертикали', overflow.rows === 8);
  await small.screenshot({ path: '/root/tutor-app/shot-5-1280.png' });
  await small.close();
  // вернуть контроль главной странице после чужого claimTab
  if (await page.locator('#takeover').count()){
    await page.locator('#tk').click(); await page.waitForTimeout(200);
  }

  /* ───── 9. Чистый старт (как у получателя файла) ───── */
  console.log('\n── Чистый старт ──');
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ru-RU' });
  const pc = await ctx2.newPage();
  await pc.goto(URL); await pc.waitForTimeout(300);
  await pc.evaluate(() => localStorage.clear());
  await pc.reload(); await pc.waitForTimeout(400);
  t('на чужом компьютере файл открывается с приветствием', await pc.locator('#welcome').isVisible());
  await pc.screenshot({ path: '/root/tutor-app/shot-0-welcome.png' });
  await pc.locator('#w-clean').click(); await pc.waitForTimeout(300);
  t('чистый старт: журнал пуст', await pc.evaluate(() =>
    window.__journal.data.students.length === 0));
  t('чистый старт: подсказка добавить первого ученика', await pc.locator('.empty').isVisible());
  await pc.locator('#addStudent').click(); await pc.waitForTimeout(200);
  await pc.locator('#n-name').fill('Первый Ученик');
  await pc.locator('[data-x=s]').click(); await pc.waitForTimeout(300);
  t('первый ученик добавляется', await pc.locator('td.namecell:has-text("Первый Ученик")').count() === 1);
  await pc.reload(); await pc.waitForTimeout(400);
  t('чистый журнал сохраняется между запусками', await pc.evaluate(() =>
    window.__journal.data.students.length === 1));
  await ctx2.close();

  /* ───── 10. Телефон ───── */
  console.log('\n── Телефон ──');
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 },
    hasTouch: true, isMobile: true, locale: 'ru-RU' });
  const mp = await mctx.newPage();
  mp.on('pageerror', e => errors.push('mobile pageerror: ' + e.message));
  await mp.goto(URL); await mp.waitForTimeout(300);
  await mp.evaluate(() => localStorage.clear());
  await mp.reload(); await mp.waitForTimeout(400);
  await mp.locator('#w-demo').click(); await mp.waitForTimeout(600);

  t('на телефоне открывается сетка', await mp.locator('td.day').count() > 100);
  t('шапка помещается в ширину телефона', await mp.evaluate(() =>
    document.querySelector('header').scrollWidth <= innerWidth + 2));
  t('сетка автоматически прокручена к сегодняшнему дню', await mp.evaluate(() =>
    document.querySelector('.gridwrap').scrollLeft > 0));
  t('ячейки увеличены под палец', await mp.evaluate(() =>
    document.querySelector('td.day').getBoundingClientRect().height >= 44));

  // тап отмечает занятие
  const mcell = mp.locator('td.day').nth(5);
  const msid = await mcell.getAttribute('data-s');
  const mb1 = await mp.evaluate(s => window.__journal.calc(+s).balance, msid);
  await mcell.tap(); await mp.waitForTimeout(250);
  const mb2 = await mp.evaluate(s => window.__journal.calc(+s).balance, msid);
  t('тап по ячейке отмечает или снимает занятие', Math.abs(mb1 - mb2) === 1);

  // длинное нажатие открывает меню статусов
  await mp.evaluate(() => {
    const c = document.querySelectorAll('td.day')[7];
    const r = c.getBoundingClientRect();
    c.dispatchEvent(new PointerEvent('pointerdown',
      { bubbles: true, clientX: r.x + 8, clientY: r.y + 8, pointerType: 'touch' }));
  });
  await mp.waitForTimeout(650);
  await mp.evaluate(() => {
    document.querySelectorAll('td.day')[7].dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }));
  });
  t('длинное нажатие открывает меню статусов', await mp.locator('#menu').isVisible());
  await mp.locator('#menu div[data-a="Отменён вовремя"]').click(); await mp.waitForTimeout(250);
  t('статус из меню применяется на телефоне', await mp.evaluate(() =>
    window.__journal.data.lessons.some(l => l.status === 'cancelled_free')));
  await mp.waitForTimeout(400);                  // окно подавления клика после длинного нажатия

  // тап сразу после длинного нажатия не проглатывается
  const tb1 = await mp.evaluate(s => window.__journal.calc(+s).balance, msid);
  await mcell.tap(); await mp.waitForTimeout(250);
  const tb2 = await mp.evaluate(s => window.__journal.calc(+s).balance, msid);
  t('обычный тап после длинного нажатия работает', Math.abs(tb1 - tb2) === 1);

  // карточка ученика — на весь экран
  await mp.locator('td.namecell').nth(1).click(); await mp.waitForTimeout(350);
  t('карточка ученика раскрывается во весь экран', await mp.evaluate(() =>
    Math.abs(document.querySelector('.drawer').getBoundingClientRect().width - innerWidth) < 2));
  await mp.keyboard.press('Escape'); await mp.waitForTimeout(200);

  // финансы перестраиваются в две колонки
  await mp.locator('#tabs [data-m=money]').click(); await mp.waitForTimeout(500);
  t('плитки финансов встают в две колонки', await mp.evaluate(() =>
    getComputedStyle(document.querySelector('.tiles')).gridTemplateColumns.split(' ').length === 2));
  t('графики строятся и на телефоне', await mp.locator('.chart svg').count() === 3);
  await mp.screenshot({ path: '/root/tutor-app/shot-9-mobile-money.png' });
  await mp.locator('#tabs [data-m=grid]').click(); await mp.waitForTimeout(400);
  await mp.screenshot({ path: '/root/tutor-app/shot-8-mobile.png' });
  await mctx.close();

  /* ───── 11. PWA-файлы ───── */
  console.log('\n── Мобильная установка (PWA) ──');
  const fs = require('fs');
  const pwaDir = path.join(__dirname, 'мобильная-версия');
  t('манифест валиден и standalone', (() => {
    try{
      const m = JSON.parse(fs.readFileSync(path.join(pwaDir, 'manifest.webmanifest'), 'utf8'));
      return m.display === 'standalone' && m.icons.length >= 3 && m.name.includes('репетитора');
    }catch(e){ return false }
  })());
  t('service worker без синтаксических ошибок', (() => {
    try{ new Function(fs.readFileSync(path.join(pwaDir, 'sw.js'), 'utf8')); return true }
    catch(e){ return false }
  })());
  t('index.html подключает манифест и service worker', (() => {
    const h = fs.readFileSync(path.join(pwaDir, 'index.html'), 'utf8');
    return h.includes('manifest.webmanifest') && h.includes('serviceWorker');
  })());
  t('иконки на месте', ['icon-192.png', 'icon-512.png', 'icon-maskable.png']
    .every(f => fs.existsSync(path.join(pwaDir, f))));

  console.log('\n' + (errors.length ? 'ОШИБКИ КОНСОЛИ:\n' + errors.join('\n') : 'Ошибок в консоли нет'));
  if (errors.length) fail += errors.length;
  console.log(`\nИТОГ: ${pass} пройдено, ${fail} провалено`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
