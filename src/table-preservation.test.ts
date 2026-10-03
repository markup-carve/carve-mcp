import { describe, expect, it } from 'vitest';
import { carveToAstJson } from '@markup-carve/carve';
import { assessTablePreservation } from './table-preservation.js';

describe('table-structure-v1 assessment', () => {
  it.each([
    ['| 1 | 2 |\n|= A |= B |\n', 'markdown', 'rowOrder'],
    ['|= A |= B |\n|= C |= D |\n', 'markdown', 'header'],
    ['|=> A |\n| 1 |\n|=< B |\n', 'markdown', 'align'],
    ['|> 1 | 2 |\n| 3 | 4 |\n', 'markdown', 'align'],
    ['|=> A |\n| 1 |\n', 'ansi', 'align'],
    ['|= A |\n| 1 |\n', 'plain', 'header'],
    ['> |= A | < |\n> | 1 | 2 |\n', 'markdown', 'colspan'],
  ] as const)('assesses %s for %s', (source, target, field) => {
    expect(assessTablePreservation(carveToAstJson(source), target).diagnostics.map(d => d.field)).toContain(field);
  });

  it('retains ordinary ANSI header styling and bounds findings independently of counts', () => {
    expect(assessTablePreservation(carveToAstJson('|= A |= B |\n| 1 | 2 |\n'), 'ansi').totalDiagnostics).toBe(0);
    const report = assessTablePreservation(carveToAstJson('|= A | B |\n'.repeat(101)), 'markdown');
    expect(report).toMatchObject({totalDiagnostics:101, maxDiagnostics:100, truncated:true});
    expect(report.diagnostics).toHaveLength(100);
  });

  it('names structured short captions and non-implicit row groups', () => {
    const ast = {type:'document', srcByteLength:0, children:[{type:'table', shortCaption:[{type:'text',value:'Short'}], rows:[{type:'table_row',cells:[{type:'table_cell',header:false,children:[{type:'text',value:'Data'}]}]}], rowGroups:{headRows:0,bodies:[],footRows:1}}]};
    expect(assessTablePreservation(ast,'html').diagnostics.map(d=>d.field)).toEqual(['shortCaption']);
    expect(assessTablePreservation(ast,'markdown').diagnostics.map(d=>d.field)).toEqual(['shortCaption','rowGroups']);
  });
});


it('does not assign alignment loss to span markers or default left alignment', () => {
  const merged = assessTablePreservation(carveToAstJson('|=> A | < |= C |\n| 1 | 2 | 3 |\n'), 'markdown');
  expect(merged.diagnostics.some(d => d.path === '/children/0/rows/0/cells/1')).toBe(false);
  for (const target of ['plain', 'ansi'] as const) {
    const report = assessTablePreservation(carveToAstJson('|< A |\n| 1 |\n'), target);
    expect(report.diagnostics.filter(d => d.field === 'align')).toHaveLength(0);
  }
});
