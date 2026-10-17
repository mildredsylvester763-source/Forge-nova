import { parseWorkPlan } from './work-plan-parser';

describe('parseWorkPlan', () => {
  it('accepts a valid dependency graph', () => {
    const result = parseWorkPlan(JSON.stringify({
      title: 'Build a small web application',
      nodes: [
        { key: 'analyze', type: 'ANALYSIS', title: 'Analyze requirements', dependsOnKeys: [] },
        { key: 'generate', type: 'GENERATE', title: 'Generate source', dependsOnKeys: ['analyze'] },
        { key: 'test', type: 'TEST', title: 'Test source', dependsOnKeys: ['generate'] },
      ],
    }));
    expect(result.nodes).toHaveLength(3);
  });

  it('rejects unknown dependencies', () => {
    expect(() => parseWorkPlan(JSON.stringify({
      title: 'Invalid plan',
      nodes: [{ key: 'build', type: 'BUILD', title: 'Build', dependsOnKeys: ['missing'] }],
    }))).toThrow(/unknown dependency/);
  });

  it('rejects cyclic dependencies', () => {
    expect(() => parseWorkPlan(JSON.stringify({
      title: 'Cyclic plan',
      nodes: [
        { key: 'first', type: 'ANALYSIS', title: 'First', dependsOnKeys: ['second'] },
        { key: 'second', type: 'BUILD', title: 'Second', dependsOnKeys: ['first'] },
      ],
    }))).toThrow(/cyclic dependency/);
  });

  it('rejects replacement of the original request node', () => {
    expect(() => parseWorkPlan(JSON.stringify({
      title: 'Invalid',
      nodes: [{ key: 'user-request', type: 'ANALYSIS', title: 'Overwrite request', dependsOnKeys: [] }],
    }))).toThrow(/immutable original-request node/);
  });
});
