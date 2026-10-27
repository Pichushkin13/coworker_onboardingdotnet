const { chromium } = require('../.tools/node_modules/playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = process.env.TEST_URL || 'http://127.0.0.1:8000';
const artifacts = path.resolve(__dirname, '../test-artifacts');

(async () => {
  fs.mkdirSync(artifacts, { recursive: true });
  const authResponse = await fetch(base + '/api/auth/login', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'admin@example.local',password:'admin'})});
  assert.ok(authResponse.ok);
  const auth = await authResponse.json();
  const data = await (await fetch(base + '/api/app-data', {headers:{Authorization:'Bearer ' + auth.token}})).json();
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true });
  try {
    const context = await browser.newContext({viewport:{width:1440,height:1000}});
    await context.addInitScript(auth => {
      localStorage.setItem('authToken', auth.token);
      localStorage.setItem('authUser', JSON.stringify(auth));
      localStorage.setItem('selectedCourse', 'course_ba_card_replacement_onboarding');
      localStorage.setItem('selectedModule', 'mod_card_onboarding_read_1');
      localStorage.setItem('adminToken', '');
    }, auth);
    const drafts = new Map();
    let submission;
    await context.route('**/api/app-data', route => route.fulfill({json:{...data,drafts:[...drafts.values()]}}));
    await context.route('**/api/draft/save', route => {
      const body = route.request().postDataJSON();
      drafts.set(body.activityId, body);
      return route.fulfill({json:{status:'ok'}});
    });
    await context.route('**/api/draft/clear-module', route => route.fulfill({json:{status:'ok'}}));
    await context.route('**/api/assessment/submit-module', route => {
      submission = route.request().postDataJSON();
      return route.fulfill({json:{attemptNo:1,effectiveMaxAttempts:3,resultStatus:'pending_review'}});
    });
    await context.route('**/sql.js/1.10.3/*', route => {
      const name = new URL(route.request().url()).pathname.split('/').pop();
      assert.ok(['sql-wasm.js', 'sql-wasm.wasm'].includes(name));
      return route.fulfill({body:fs.readFileSync(path.resolve(__dirname,'../.tools/node_modules/sql.js/dist',name)),contentType:name.endsWith('.wasm')?'application/wasm':'application/javascript',headers:{'Access-Control-Allow-Origin':'*'}});
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.locator('.worksheet-form').waitFor();
    assert.equal(await page.locator('text=Unsupported activity type').count(), 0);
    assert.equal(await page.locator('.interview-message').count(), 39);
    assert.equal(await page.locator('.interview-topic').count(), 11);
    assert.equal(await page.locator('.worksheet-form textarea').count(), 3);
    assert.ok(await page.locator('.interview-banner img').evaluate(img => img.complete && img.naturalWidth > 0));
    await page.locator('.interview-quote').first().click();
    const first = page.locator('.worksheet-form textarea').first();
    assert.match(await first.inputValue(), /Анна:/);
    await page.locator('.worksheet-actions button').click();
    await page.getByText('Ответы сохранены', {exact:true}).waitFor();
    await page.reload();
    await page.locator('.worksheet-form').waitFor();
    assert.match(await first.inputValue(), /Анна:/);
    await page.locator('.interview-banner').scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(artifacts,'interview-desktop.png'),fullPage:true});
    await page.screenshot({path:path.join(artifacts,'interview-desktop-viewport.png')});
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:path.join(artifacts,'interview-mobile.png'),fullPage:true});
    await page.locator('.interview-banner').scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(artifacts,'interview-mobile-viewport.png')});
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile horizontal overflow');
    for (const module of data.modules) {
      await page.evaluate(id => selectModule(id), module.moduleId);
      assert.equal(await page.locator('text=Unsupported activity type').count(), 0, module.title);
      assert.equal(data.activities.filter(a => a.moduleId === module.moduleId && a.activityType === 'html_content').length, 1, 'One reading per module: ' + module.title);
    }
    assert.ok(!data.modules.some(m => m.moduleId === 'mod_card_onboarding_deliverables'));
    const fillWorksheets = async () => {
      for (const field of await page.locator('.worksheet-form textarea').all()) await field.fill('Ответ с обоснованием, источником и результатом выполнения задания.');
    };
    const solveMapping = async activity => {
      const box = page.locator('[id="brick_' + activity.activityId + '"]');
      const mapping = JSON.parse(activity.configJson).correctMapping;
      for (const [target, value] of Object.entries(mapping)) {
        await box.locator('.drag-item').filter({hasText:value}).first().press('Enter');
        await box.getByRole('button', {name:target,exact:true}).press('Enter');
      }
    };
    for (const n of [1,2,3,4,5]) {
      const moduleId = 'mod_card_onboarding_read_' + n;
      await page.evaluate(id => selectModule(id), moduleId);
      const checks = data.activities.filter(a => a.moduleId === moduleId && ['drag_mapping','decision_table','drag_order'].includes(a.activityType));
      for (const activity of checks) {
        const cfg = JSON.parse(activity.configJson);
        if (activity.activityType === 'drag_mapping') {
          await solveMapping(activity);
        } else if (activity.activityType === 'decision_table') {
          for (let i=0;i<cfg.rows.length;i++) await page.locator(`[id="dt_${activity.activityId}_${i}"]`).selectOption(cfg.rows[i].correctOutcome);
        } else {
          for (let i=0;i<cfg.correctOrder.length;i++) {
            const item = page.locator(`[id="order_${activity.activityId}"] .order-item`).filter({hasText:cfg.correctOrder[i]});
            let index = await item.evaluate(el => [...el.parentElement.children].indexOf(el));
            while (index-- > i) await item.press('ArrowUp');
          }
          assert.equal(await page.evaluate(id => evaluateOrder(findActivity(id)).passed, activity.activityId), true);
          await page.waitForTimeout(650);
          await page.evaluate(() => selectModule('mod_card_onboarding_read_0'));
          await page.evaluate(id => selectModule(id), moduleId);
          assert.equal(await page.evaluate(id => evaluateOrder(findActivity(id)).passed, activity.activityId), true, 'Order draft restored');
        }
        assert.equal(await page.evaluate(id => automaticScoreRatio(findActivity(id)), activity.activityId), 1);
      }
      await fillWorksheets();
      await page.locator('button[onclick^="submitAssessment"]').click();
      await page.waitForFunction(() => document.getElementById('assessment_result')?.textContent.includes('Submitted'));
      assert.ok(submission.taskResults.filter(r => checks.some(a => a.activityId === r.activityId)).every(r => r.validationStatus === 'passed'));
      if (n===3) {
        await page.locator('.lesson-heading').scrollIntoViewIfNeeded();
        await page.screenshot({path:path.join(artifacts,'simplified-mvp-mobile.png')});
      }
    }
    // Sections 7-11: actual SQL execution, contract, accessible mapping and mentor submissions.
    await page.evaluate(() => selectModule('mod_card_onboarding_read_7'));
    assert.equal(await page.locator('.expected-answer').count(), 0, 'Mentor SQL examples must not be rendered for students');
    assert.equal(await page.locator('.sql-task-brief').count(), 3);
    for (const editor of await page.locator('.sql-editor').all()) {
      assert.equal(await editor.inputValue(), '', 'New SQL tasks start without solution fragments or comments');
      assert.equal(await editor.getAttribute('placeholder'), 'Введите SQL-запрос');
    }
    assert.ok(!(await page.locator('.sql-task-brief').allTextContents()).some(text => /синтетическая|Учебные параметры|Учебная модель/.test(text)));
    await page.locator('.sql-task-brief').first().scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'SQL task mobile overflow');
    await page.screenshot({path:path.join(artifacts,'sql-task-mobile.png')});
    await page.setViewportSize({width:1440,height:1000});
    await page.screenshot({path:path.join(artifacts,'sql-task-desktop.png')});
    await page.setViewportSize({width:390,height:844});
    const queries = [
      "SELECT a.FILE_URL, p.PAYMENT_NUMBER FROM INTERNATIONAL_PAYMENT p JOIN INTERNATIONAL_PAYMENT_ATTACHMENT a ON a.PAYMENT_ID=p.ID WHERE p.SENDER='Ani' AND p.RECIPIENT='David' AND p.CREATED_AT>'2023-01-15 00:00:00'",
      'SELECT SUM(AMOUNT_AMD) AS "TOTAL_VAT_REFUND" FROM BUDGET_PAYMENT WHERE PURPOSE=\'VAT_REFUND\' AND IS_FOREIGN_CITIZEN=1 AND AMOUNT_AMD>=1000 AND PAYMENT_DATE>=\'2023-01-01\' AND PAYMENT_DATE<\'2023-04-01\'',
      'SELECT CLIENT_CODE, COUNT(*) AS ACCOUNT_COUNT FROM ACCOUNT GROUP BY CLIENT_CODE ORDER BY ACCOUNT_COUNT DESC LIMIT 1'
    ];
    const sqlActivities = data.activities.filter(a => a.moduleId === 'mod_card_onboarding_read_7' && a.activityType === 'sql_task').sort((a,b)=>a.displayOrder-b.displayOrder);
    for (const activity of sqlActivities) {
      const validation = JSON.parse(activity.configJson).validation;
      assert.ok(validation.expectedColumns.every(column => /^[A-Z][A-Z0-9_]*$/.test(column)), 'SQL result columns use English identifiers');
    }
    assert.deepEqual(JSON.parse(sqlActivities[1].configJson).validation.expectedColumns, ['TOTAL_VAT_REFUND']);
    for (let i=0;i<sqlActivities.length;i++) {
      const id = sqlActivities[i].activityId;
      await page.locator(`[id="sql_${id}"]`).fill(queries[i]);
      await page.evaluate(id => runSql(id), id);
      assert.equal(await page.evaluate(id => state.sqlRuntime[id]?.validationStatus, id), 'passed');
      const mentorQuery = JSON.parse(sqlActivities[i].configJson).validation.expectedQuery;
      assert.ok(mentorQuery);
      await page.locator(`[id="sql_${id}"]`).fill(mentorQuery);
      await page.evaluate(id => runSql(id), id);
      assert.equal(await page.evaluate(id => state.sqlRuntime[id]?.validationStatus, id), 'passed', 'Mentor example query');
    }
    await page.locator('button[onclick^="submitAssessment"]').click();
    await page.waitForFunction(() => document.getElementById('assessment_result')?.textContent.includes('Submitted'));
    assert.equal(submission.taskResults.length, 3);
    assert.ok(submission.taskResults.every(r => r.validationStatus === 'passed' && r.score === 10));
    await page.evaluate(() => selectModule('mod_card_onboarding_read_8'));
    const video = page.locator('.video-frame iframe');
    assert.equal(await video.count(), 1);
    assert.match(await video.getAttribute('src'), /youtube-nocookie\.com\/embed\/videoseries\?list=PLOspHqNVtKAAAq9pHWlEiRUVcYMCcu4X0/);
    const contractActivity = data.activities.find(a => a.moduleId === 'mod_card_onboarding_read_8' && a.activityType === 'rest_contract');
    const contract = JSON.parse(contractActivity.configJson).validation;
    for (const [control,property] of [['method','method'],['path','path'],['body','requestBody'],['success','successStatus']]) {
      await page.locator(`[id="rest_${control}_${contractActivity.activityId}"]`).selectOption(String(contract[property]));
    }
    for (const [group,property] of [['error_statuses','errorStatuses'],['response_fields','responseFields']]) {
      for (const value of contract[property]) await page.locator(`input[name="rest_${group}_${contractActivity.activityId}"][value="${value}"]`).check();
    }
    for (const param of contract.queryParams) await page.locator(`input[name="rest_query_params_${contractActivity.activityId}"][value="${param.name}=${param.value}"]`).check();
    const contractResult = await page.evaluate(id => evaluateRestContract(findActivity(id)), contractActivity.activityId);
    assert.equal(contractResult.passed, true, JSON.stringify({contractResult, expected:contract}));
    await fillWorksheets();
    await page.waitForTimeout(650);
    await page.evaluate(() => selectModule('mod_card_onboarding_read_9'));
    assert.equal(await page.locator('.lesson-heading h3').textContent(), 'Проверяем курсы валют для экрана банка');
    assert.equal(await page.locator('.worksheet-form textarea').count(), 2, 'Postman task keeps two answer fields');
    await page.locator('.lesson-resources summary').click();
    assert.equal(await page.getByRole('link', {name:'Frankfurter v1: запросы и параметры'}).getAttribute('href'), 'https://frankfurter.dev/v1/');
    assert.ok(!(await page.locator('#activityList').textContent()).includes('/training/exchange-rates'), 'No nonexistent training endpoint');
    await page.locator('.lesson-heading').scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Postman task mobile overflow');
    await page.screenshot({path:path.join(artifacts,'postman-task-mobile.png')});
    await page.setViewportSize({width:1440,height:1000});
    await page.screenshot({path:path.join(artifacts,'postman-task-desktop.png')});
    await page.setViewportSize({width:390,height:844});
    const mappingActivity = data.activities.find(a => a.moduleId === 'mod_card_onboarding_read_9' && a.activityType === 'drag_mapping');
    const mapping = JSON.parse(mappingActivity.configJson).correctMapping;
    await solveMapping(mappingActivity);
    assert.equal(await page.evaluate(id => evaluateMapping(findActivity(id)).passed, mappingActivity.activityId), true);
    await page.waitForTimeout(650);
    await page.evaluate(() => selectModule('mod_card_onboarding_read_8'));
    assert.equal(await page.evaluate(id => evaluateRestContract(findActivity(id)).passed, contractActivity.activityId), true, 'REST draft restored');
    await page.locator('button[onclick^="submitAssessment"]').click();
    await page.waitForFunction(() => document.getElementById('assessment_result')?.textContent.includes('Submitted'));
    assert.equal(submission.taskResults.length, 2);
    assert.ok(submission.taskResults.every(r => data.activities.find(a => a.activityId === r.activityId).activityType !== 'video'));
    assert.equal(submission.taskResults.find(r => r.activityId === contractActivity.activityId).score, 10);
    await page.evaluate(() => selectModule('mod_card_onboarding_read_9'));
    assert.equal(await page.evaluate(id => evaluateMapping(findActivity(id)).passed, mappingActivity.activityId), true, 'Mapping draft restored');
    await page.locator('.mapping-drag').scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(artifacts,'api-mapping-mobile.png')});
    await page.setViewportSize({width:1440,height:1000});
    await page.locator('.mapping-drag').scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(artifacts,'mapping-restored-desktop.png')});
    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    for (const moduleNumber of [9,10,11]) {
      await page.evaluate(n => selectModule('mod_card_onboarding_read_' + n), moduleNumber);
      await fillWorksheets();
      await page.locator('button[onclick^="submitAssessment"]').click();
      await page.waitForFunction(() => document.getElementById('assessment_result')?.textContent.includes('Submitted'));
      assert.ok(submission.taskResults.some(r => r.validationStatus === 'pending_review'));
      assert.ok(!submission.taskResults.some(r => data.activities.find(a=>a.activityId===r.activityId)?.activityType === 'html_content'));
    }
    await page.evaluate(() => selectModule('mod_card_onboarding_read_1'));
    for (const field of await page.locator('.worksheet-form textarea').all()) await field.fill('Проверяемый ответ с источником из интервью.');
    await page.locator('button[onclick^="submitAssessment"]').click();
    await page.waitForFunction(() => document.getElementById('assessment_result')?.textContent.includes('Submitted'));
    assert.equal(submission.taskResults.length, 2);
    assert.equal(submission.taskResults.find(r => r.answer.responses).validationStatus, 'pending_review');
    assert.equal(Object.keys(submission.taskResults.find(r => r.answer.responses).answer.responses).length, 3);
    const review = await page.evaluate(answer => renderAttemptAnswer({taskType:'worksheet',answerJson:JSON.stringify(answer),configJson:'{}'}), submission.taskResults.find(r => r.answer.responses).answer);
    assert.ok(review.includes('Проверяемый ответ'));
    await page.evaluate(token => { state.adminToken = token; render(); }, auth.adminToken);
    const worksheet = data.activities.find(a => a.activityType === 'worksheet' && a.moduleId === 'mod_card_onboarding_read_1');
    await page.evaluate(id => openActivityEditor('mod_card_onboarding_read_1', id), worksheet.activityId);
    assert.equal(await page.locator('#ae_type').inputValue(), 'worksheet');
    assert.equal(await page.locator('.evidence-prompt-row').count(), 3);
    assert.equal(await page.locator('#ae_evidence_unlock_enabled').count(), 0);
    await page.evaluate(() => { closeModal(); selectModule('mod_card_onboarding_read_7'); });
    assert.equal(await page.getByText('Пример запроса для ментора', {exact:true}).count(), 3);
    const sqlActivity = sqlActivities[0];
    await page.evaluate(id => openActivityEditor('mod_card_onboarding_read_7', id), sqlActivity.activityId);
    assert.equal(await page.locator('#ae_expected_query').inputValue(), JSON.parse(sqlActivity.configJson).validation.expectedQuery);
    assert.deepEqual(errors, []);
    console.log('Browser: sections 1-11 rendered; three SQL queries passed; REST, mapping, drafts, mobile layout, mentor submissions and admin editor passed. No attempts or drafts written to the database.');
  } finally { await browser.close(); }
})().catch(error => {console.error(error);process.exitCode = 1;});
