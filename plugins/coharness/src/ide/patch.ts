export interface PatchEdit {
  path: string;
  create?: boolean;
  find?: string;
  replace: string;
  reason: string;
  expected: string;
  sourceIds: string[];
}

export interface FileState {
  exists: boolean;
  content: string;
}

export interface PlannedEdit extends PatchEdit {
  start: number;
  end: number;
  oldStart: number;
  oldEnd: number;
}

export interface PlannedWrite {
  path: string;
  content: string;
  edits: PlannedEdit[];
}

function lineCount(value: string): number {
  return value === '' ? 0 : value.split('\n').length;
}

function lineAt(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

function occurrences(content: string, find: string): number[] {
  const positions: number[] = [];
  let index = content.indexOf(find);
  while (index >= 0) {
    positions.push(index);
    index = content.indexOf(find, index + find.length);
    if (positions.length > 1) break;
  }
  return positions;
}

// 系统在写入前计算机每处替换的最终行号。任何歧义都会阻止整批修改。
export function planEdits(files: Map<string, FileState>, edits: PatchEdit[]): PlannedWrite[] {
  const grouped = new Map<string, PatchEdit[]>();
  for (const edit of edits) {
    if (!grouped.has(edit.path)) grouped.set(edit.path, []);
    grouped.get(edit.path)!.push(edit);
  }
  const writes: PlannedWrite[] = [];
  for (const [path, fileEdits] of grouped) {
    const state = files.get(path);
    if (!state) throw new Error(`系统没有读取目标文件：${path}`);
    const creating = fileEdits.filter(edit => edit.create).length > 0;
    if (creating) {
      if (state.exists) throw new Error(`目标文件已经存在：${path}`);
      if (fileEdits.length !== 1) throw new Error(`新文件只能提交一条创建修改：${path}`);
      const edit = fileEdits[0]!;
      if ((edit.find ?? '') !== '') throw new Error(`新文件不需要 find 内容：${path}`);
      if (!edit.replace) throw new Error(`新文件内容不能为空：${path}`);
      writes.push({ path, content: edit.replace, edits: [{ ...edit, start: 1, end: lineCount(edit.replace), oldStart: 1, oldEnd: 0 }] });
      continue;
    }
    if (!state.exists) throw new Error(`目标文件不存在：${path}`);
    if (fileEdits.some(edit => !edit.find)) throw new Error(`替换内容必须提供 find：${path}`);
    const found = fileEdits.map(edit => {
      const positions = occurrences(state.content, edit.find!);
      if (positions.length === 0) throw new Error(`系统在 ${path} 中没有找到 find 内容。`);
      if (positions.length > 1) throw new Error(`find 内容在 ${path} 中出现多次。请增加上下文。`);
      const index = positions[0]!;
      const oldLines = lineCount(edit.find!);
      const newLines = lineCount(edit.replace);
      return { edit, index, oldLines, newLines, oldStart: lineAt(state.content, index), oldEnd: lineAt(state.content, index) + Math.max(0, oldLines - 1) };
    }).sort((left, right) => left.index - right.index);
    for (let index = 1; index < found.length; index++) {
      const previous = found[index - 1]!;
      if (previous.index + previous.edit.find!.length > found[index]!.index) throw new Error(`同一文件的修改范围发生重叠：${path}`);
    }
    let delta = 0;
    const planned: PlannedEdit[] = found.map(item => {
      const start = Math.max(1, item.oldStart + delta);
      const end = start + item.newLines - 1;
      delta += item.newLines - item.oldLines;
      return { ...item.edit, start, end, oldStart: item.oldStart, oldEnd: item.oldEnd };
    });
    let content = state.content;
    for (const item of [...found].reverse()) content = content.slice(0, item.index) + item.edit.replace + content.slice(item.index + item.edit.find!.length);
    writes.push({ path, content, edits: planned });
  }
  return writes;
}
