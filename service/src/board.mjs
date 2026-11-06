// Board fields (design 6.3): on a GitHub Projects v2 board named in the state
// branch's coordinator.json, keep each unit's card in step: "Run" (text),
// "Unit state" (building, judging, passed, stopped, needs you) and, when
// coordinator.json maps it, the board's own Status. The two coordinator fields
// are created on first use; nothing else on the board is created, renamed or
// restructured, and a card that is not on the board is left alone (the board
// sub-skill's rule: move cards only).
export const RUN_FIELD = 'Run';
export const STATE_FIELD = 'Unit state';
export const STATES = ['building', 'judging', 'passed', 'stopped', 'needs you'];

const FIELDS = `fields(first: 50) { nodes { __typename ... on ProjectV2FieldCommon { id name dataType } ... on ProjectV2SingleSelectField { options { id name } } } }`;
const PROJECT = `query CoordinatorProject($login: String!, $number: Int!) {
  organization(login: $login) { projectV2(number: $number) { id ${FIELDS} } }
}`;
const ITEMS = `query CoordinatorItems($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issueOrPullRequest(number: $number) {
    ... on Issue { projectItems(first: 20) { nodes { id project { id } } } }
    ... on PullRequest { projectItems(first: 20) { nodes { id project { id } } } } } }
}`;
const CREATE = `mutation CoordinatorField($project: ID!, $name: String!, $type: ProjectV2CustomFieldType!, $options: [ProjectV2SingleSelectFieldOptionInput!]) {
  createProjectV2Field(input: { projectId: $project, name: $name, dataType: $type, singleSelectOptions: $options }) { projectV2Field { __typename } }
}`;
const SET = `mutation CoordinatorSet($project: ID!, $item: ID!, $field: ID!, $value: ProjectV2FieldValue!) {
  updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: $value }) { projectV2Item { id } }
}`;

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
// coordinator.json's "board", checked: { owner, number, status?: { <state>: <option name> } }, else null.
export function boardConfig(c) {
  const b = c?.board;
  if (!b || typeof b !== 'object' || !LOGIN.test(String(b.owner ?? '')) || !Number.isSafeInteger(b.number) || b.number <= 0) return null;
  const status = {};
  for (const s of STATES) if (typeof b.status?.[s] === 'string' && b.status[s].length <= 100) status[s] = b.status[s];
  return { owner: b.owner, number: b.number, status };
}

const byName = (fields, name) => fields.find((f) => f?.name?.toLowerCase() === name.toLowerCase()) ?? null;
const option = (field, name) => field?.options?.find((o) => o.name.toLowerCase() === String(name).toLowerCase()) ?? null;

// One board session per refresh: the project and its fields are read once.
export function boardSession({ gh, token, board }) {
  let project;
  async function load() {
    if (project !== undefined) return project;
    const d = await gh.graphql(token, PROJECT, { login: board.owner, number: board.number });
    project = d?.organization?.projectV2 ?? null;
    if (!project) return null;
    const fields = project.fields.nodes;
    // The coordinator's own two fields, made once.
    if (!byName(fields, RUN_FIELD)) await gh.graphql(token, CREATE, { project: project.id, name: RUN_FIELD, type: 'TEXT' });
    if (!byName(fields, STATE_FIELD)) await gh.graphql(token, CREATE, { project: project.id, name: STATE_FIELD, type: 'SINGLE_SELECT', options: STATES.map((name) => ({ name, color: 'GRAY', description: '' })) });
    if (!byName(fields, RUN_FIELD) || !byName(fields, STATE_FIELD)) project = (await gh.graphql(token, PROJECT, { login: board.owner, number: board.number }))?.organization?.projectV2 ?? null;
    return project;
  }

  // Sets the card of ref ({ repo, n }) for this unit. Returns 'set', 'not on board' or 'no board'.
  async function update(ref, { runId, state }) {
    const p = await load();
    if (!p) return 'no board';
    const [owner, name] = ref.repo.split('/');
    const d = await gh.graphql(token, ITEMS, { owner, name, number: Number(ref.n) });
    const item = d?.repository?.issueOrPullRequest?.projectItems?.nodes?.find((i) => i?.project?.id === p.id);
    if (!item) return 'not on board';
    const fields = p.fields.nodes;
    const set = (field, value) => gh.graphql(token, SET, { project: p.id, item: item.id, field: field.id, value });
    const runField = byName(fields, RUN_FIELD);
    if (runField) await set(runField, { text: runId });
    const opt = option(byName(fields, STATE_FIELD), state);
    if (opt) await set(byName(fields, STATE_FIELD), { singleSelectOptionId: opt.id });
    const status = board.status[state] && option(byName(fields, 'Status'), board.status[state]);
    if (status) await set(byName(fields, 'Status'), { singleSelectOptionId: status.id });
    return 'set';
  }
  return { update };
}
