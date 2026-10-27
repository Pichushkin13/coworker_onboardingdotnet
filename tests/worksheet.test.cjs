const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const pack = JSON.parse(fs.readFileSync(path.join(root, 'content/card-onboarding.json'), 'utf8'));
const nodes = new Map();
const context = vm.createContext({
  pack, assert, URL,
  window: {location:{origin:'http://127.0.0.1:8000'}},
  localStorage: { getItem: () => null, setItem() {} },
  document: { getElementById: id => nodes.get(id), querySelectorAll: () => [] },
  setTimeout, clearTimeout, setInterval, clearInterval, console
});
let source = fs.readFileSync(path.join(root, 'wwwroot/app.js'), 'utf8');
source = source.slice(0, source.indexOf('$("authBtn").onclick'));
vm.runInContext(source, context);
context.nodeFor = (id, value = '') => nodes.set(id, { value, innerHTML: '', className: '' });
vm.runInContext(`
  assert.equal(embeddableVideoUrl('https://www.youtube.com/playlist?list=PLtest'), 'https://www.youtube-nocookie.com/embed/videoseries?list=PLtest');
  assert.equal(embeddableVideoUrl('https://youtu.be/example'), 'https://www.youtube-nocookie.com/embed/example');
  const module = pack.modules.find(m => m.id === 'mod_card_onboarding_read_1');
  const worksheet = module.activities.find(a => a.type === 'worksheet');
  const activity = { ...worksheet, activityId: worksheet.id, moduleId: module.id, activityType: worksheet.type, status: 'active' };
  state.authToken = 'test';
  state.selectedModule = module.id;
  state.data = { modules: [{moduleId: module.id, reviewMode: 'mixed'}], drafts: [], activities: [activity, {activityId: 'reading', moduleId: module.id, activityType: 'html_content', status: 'active'}] };
  const html = renderActivity(activity, true);
  assert.equal((html.match(/<textarea /g) || []).length, 3);
  assert.ok(!html.includes('data-manual-input'));
  assert.ok(!html.includes('confirm senior levels'));
  worksheet.config.prompts.forEach((p, i) => nodeFor('evidence_' + worksheet.id + '_' + i, 'Answer: ' + p.label));
  const draft = collectDraftAnswer(activity);
  assert.equal(Object.keys(draft.responses).length, 3);
  state.data.drafts = [{activityId: worksheet.id, answer: draft}];
  nodeFor('evidence_' + worksheet.id + '_0', '');
  applyDrafts(module.id);
  assert.ok(document.getElementById('evidence_' + worksheet.id + '_0').value.startsWith('Answer:'));
  state.data.drafts = [{activityId: worksheet.id, answer:{responses:{questions_0:'Existing access question',questions_1:'Existing card question'}}}];
  applyDrafts(module.id);
  assert.ok(document.getElementById('evidence_' + worksheet.id + '_1').value.includes('Existing access question'));
  assert.ok(document.getElementById('evidence_' + worksheet.id + '_1').value.includes('Existing card question'));
  applyDrafts(module.id);
  assert.equal(document.getElementById('evidence_' + worksheet.id + '_1').value.split('Existing access question').length, 2);
  worksheet.config.prompts.forEach((p, i) => nodeFor('evidence_' + worksheet.id + '_' + i, 'Answer: ' + p.label));
  const review = renderAttemptAnswer({taskType:'worksheet',answerJson:JSON.stringify({responses:{a:{label:'Source',text:'<script>test</script>'}}}),configJson:'{}'});
  assert.ok(review.includes('&lt;script&gt;'));
  assert.ok(!review.includes('<script>'));
  globalThis.sent = null;
  api = async (route, method, body) => { if (route.endsWith('submit-module')) globalThis.sent = body; return {attemptNo:1,effectiveMaxAttempts:3,resultStatus:'pending_review'}; };
  load = async () => {};
  nodeFor('assessment_result');
  globalThis.done = submitAssessment(module.id, false).then(() => {
    assert.equal(sent.taskResults.length, 1);
    assert.equal(sent.taskResults[0].validationStatus, 'pending_review');
    assert.equal(Object.keys(sent.taskResults[0].answer.responses).length, 3);
  });
`, context);
context.done.then(() => console.log('Worksheet rendering, drafts, review escaping and submission: passed.')).catch(error => { console.error(error); process.exitCode = 1; });
