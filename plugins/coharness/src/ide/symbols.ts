import ts from 'typescript';
import { parser } from '@lezer/python';
import { diffLines, structuredPatch } from 'diff';

export function symbolsFor(path: string, source: string): any[] {
  const lines = source.split('\n'), symbols: any[] = [];
  const line = (offset: number) => source.slice(0, offset).split('\n').length;
  const add = (name: string, from: number, to: number, parameters: string, count: number, calls: any[]) => {
    const start = line(from), end = line(to);
    symbols.push({ name, start, end, parameters, parameterCount: count, path, id: `${path}::${name}:${start}`,
      code: lines.slice(start-1,end).join('\n'), description: '用户可结合函数实现确认职责。', candidates: calls, calls: [], callers: [] });
  };
  if (/\.[cm]?[jt]sx?$/.test(path)) {
    const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.body) {
        const parent = node.parent;
        const name = node.name?.getText(tree) || (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) ? parent.name.getText(tree) : '匿名函数');
        const calls: any[] = [];
        const walk = (child: ts.Node) => {
          if (child !== node.body && ts.isFunctionLike(child)) return;
          if (ts.isCallExpression(child)) calls.push({ name: ts.isIdentifier(child.expression) ? child.expression.text : '',
            line: line(child.getStart(tree)), expression: child.getText(tree).slice(0,300) });
          ts.forEachChild(child, walk);
        };
        walk(node.body);
        add(name,node.getStart(tree),node.end,node.parameters.map(p=>p.getText(tree)).join(', '),node.parameters.length,calls);
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  } else if (path.endsWith('.py')) {
    const tree = parser.parse(source);
    const visit = (node: any) => {
      if (node.name === 'FunctionDefinition') {
        const name = node.getChild('VariableName'), parameters = node.getChild('ParamList'), body = node.getChild('Body');
        if (name && parameters && body) {
          const calls: any[] = [];
          const walk = (child: any) => {
            if (child.name === 'FunctionDefinition') return;
            if (child.name === 'CallExpression' && child.firstChild?.name === 'VariableName') calls.push({name: source.slice(child.firstChild.from,child.firstChild.to),line:line(child.from),expression:source.slice(child.from,child.to).slice(0,300)});
            for (let sub = child.firstChild; sub; sub=sub.nextSibling) walk(sub);
          };
          walk(body);
          let count=0; for(let sub=parameters.firstChild;sub;sub=sub.nextSibling) if(sub.name==='VariableName') count++;
          add(source.slice(name.from,name.to),node.from,node.to,source.slice(parameters.from+1,parameters.to-1),count,calls);
        }
      }
      for (let sub = node.firstChild; sub; sub=sub.nextSibling) visit(sub);
    };
    visit(tree.topNode);
  }
  for (const symbol of symbols) {
    for (const call of symbol.candidates) {
      const targets = symbols.filter(s => s.name === call.name && s.id !== symbol.id);
      if (targets.length === 1) symbol.calls.push({target:targets[0].id,line:call.line,expression:call.expression});
    }
    delete symbol.candidates;
  }
  for (const symbol of symbols) symbol.callers = symbols.flatMap(caller => caller.calls.filter((c:any)=>c.target===symbol.id).map((c:any)=>({...c,target:caller.id})));
  return symbols.sort((a,b)=>a.start-b.start);
}
export function changesFor(before: string, after: string, symbols: any[], changed: boolean) {
  const addedLines: number[] = [], removedLines: number[] = []; let old=1, next=1;
  const parts = diffLines(before, after, { timeout: 1000 });
  if (!parts) return { changes: [], addedLines, removedLines, diffUnavailable: true };
  for (const part of parts) {
    const count = part.count ?? 0;
    if (part.added) { for(let i=0;i<count;i++) addedLines.push(next++); }
    else if (part.removed) { for(let i=0;i<count;i++) removedLines.push(old++); }
    else { old+=count; next+=count; }
  }
  let changes: any[] = [];
  if (changed && !before && after) {
    const starts = [...new Set([1,...symbols.map(s=>s.start)])].sort((a,b)=>a-b);
    changes = starts.map((start,i)=>({start,end:starts[i+1] ? starts[i+1]-1 : after.split('\n').length,oldStart:1,oldEnd:0}));
  } else if (changed) {
    const patch = structuredPatch('before','after',before,after,undefined,undefined,{context:3,timeout:1000});
    if (!patch) return { changes: [], addedLines, removedLines, diffUnavailable: true };
    changes = patch.hunks.map(h=>({start:h.newStart,end:h.newStart+h.newLines-1,oldStart:h.oldStart,oldEnd:h.oldStart+h.oldLines-1}));
  }
  if(changed && !changes.length) changes=[{start:1,end:0,oldStart:1,oldEnd:0}];
  return {addedLines,removedLines, changes:changes.map((c,i)=>{
    const symbol = symbols.find(s=>s.start<=c.start && s.end>=c.start);
    return {...c,id:`change-${i+1}`,symbolId:symbol?.id??null,title:symbol ? `系统修改 ${symbol.name}。` : '系统修改该范围内的文件内容。'};
  })};
}
