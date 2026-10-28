import { EditorState, StateEffect } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, Decoration } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { foldGutter, foldKeymap, indentOnInput, bracketMatching, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { markdown } from '@codemirror/lang-markdown';

function language(path: string) {
  if (/\.[cm]?[jt]sx?$/.test(path)) return javascript({typescript:/\.tsx?$/.test(path),jsx:/\.[jt]sx$/.test(path)});
  if (path.endsWith('.py')) return python();
  if (path.endsWith('.json')) return json();
  if (/\.html?$/.test(path)) return html();
  if (path.endsWith('.css')) return css();
  if (/\.(md|markdown)$/.test(path)) return markdown();
  return [];
}
const theme = EditorView.theme({
  '&':{height:'100%',fontSize:'13px',backgroundColor:'#ffffff',color:'#24292f'},
  '.cm-scroller':{fontFamily:'"SFMono-Regular",Consolas,"Liberation Mono",monospace',lineHeight:'1.7',overflow:'auto'},
  '.cm-content':{padding:'10px 0',caretColor:'#2563eb'},
  '.cm-line':{padding:'0 14px'},
  '.cm-gutters':{backgroundColor:'#fff',color:'#8c959f',borderRight:'1px solid #eef0f3',minWidth:'48px'},
  '.cm-activeLine,.cm-activeLineGutter':{backgroundColor:'#f5f8fc'},
  '.cm-selectionBackground':{backgroundColor:'#dbeafe !important'},
  '&.cm-focused':{outline:'none'},
  '.cm-panel':{backgroundColor:'#f6f8fa',fontSize:'12px'},
  '.cm-panel input':{border:'1px solid #cbd5e1',borderRadius:'4px',padding:'3px 6px'},
  '.cm-added':{backgroundColor:'#eaf7ee'},'.cm-removed':{backgroundColor:'#fff0ef'},
  '.cm-foldPlaceholder':{backgroundColor:'#f1f5f9',border:'1px solid #dbe1e8',color:'#64748b'},
});
interface Options {doc:string;path:string;start?:number;editable?:boolean;marks?:Record<number,string>;key:string;onChange?:(value:string)=>void;onCursor?:(line:number,column:number)=>void}
const views=new Map<HTMLElement,EditorView>();
const cached=new Map<string,EditorState>();
function mount(parent:HTMLElement,options:Options) {
  const start=options.start??1;
  const extensions=[lineNumbers({formatNumber:n=>String(n+start-1)}),foldGutter(),drawSelection(),syntaxHighlighting(defaultHighlightStyle,{fallback:true}),
    language(options.path),theme,bracketMatching(),highlightSelectionMatches(),
    EditorState.readOnly.of(!options.editable),EditorView.editable.of(!!options.editable),
    EditorView.contentAttributes.of({'aria-label':options.editable?'代码编辑器':'源代码','role':'textbox','tabindex':'0'}),
    keymap.of([indentWithTab,...defaultKeymap,...historyKeymap,...searchKeymap,...foldKeymap]),
    EditorView.updateListener.of(update=>{
      if(update.docChanged)options.onChange?.(update.state.doc.toString());
      if(update.selectionSet||update.docChanged){const head=update.state.selection.main.head,line=update.state.doc.lineAt(head);options.onCursor?.(line.number+start-1,head-line.from+1);}
    })];
  if(options.editable)extensions.push(history(),indentOnInput(),highlightActiveLine(),highlightActiveLineGutter());
  else {
    const doc=EditorState.create({doc:options.doc}).doc,decorations=[];
    for(let n=1;n<=doc.lines;n++)decorations.push(Decoration.line({attributes:{'data-line':String(n+start-1)},class:options.marks?.[n+start-1]??''}).range(doc.line(n).from));
    extensions.push(EditorView.decorations.of(Decoration.set(decorations)));
  }
  const prior=cached.get(options.key);
  const state=prior&&prior.doc.toString()===options.doc?prior.update({effects:StateEffect.reconfigure.of(extensions)}).state:EditorState.create({doc:options.doc,extensions});
  const view=new EditorView({state,parent});views.set(parent,view);
  Object.defineProperties(parent,{scrollTop:{configurable:true,get:()=>view.scrollDOM.scrollTop,set:v=>{view.scrollDOM.scrollTop=v;}},scrollLeft:{configurable:true,get:()=>view.scrollDOM.scrollLeft,set:v=>{view.scrollDOM.scrollLeft=v;}}});
  parent.dataset.editorKey=options.key;parent.dataset.editorStart=String(start);
  return view;
}
function cleanup(){for(const [element,view]of views)if(!element.isConnected){cached.set(element.dataset.editorKey!,view.state);view.destroy();views.delete(element);}while(cached.size>20)cached.delete(cached.keys().next().value!);}
function reveal(element:HTMLElement,line:number){const view=views.get(element);if(!view)return;const n=Math.max(1,Math.min(view.state.doc.lines,line-Number(element.dataset.editorStart)+1));view.dispatch({effects:EditorView.scrollIntoView(view.state.doc.line(n).from,{y:'center'})});}
function selectLine(element:HTMLElement,line:number){const view=views.get(element);if(!view)return;const n=Math.max(1,Math.min(view.state.doc.lines,line-Number(element.dataset.editorStart)+1));const target=view.state.doc.line(n);view.dispatch({selection:{anchor:target.from},effects:EditorView.scrollIntoView(target.from,{y:'center'})});view.focus();}
(window as any).CoEditor={mount,cleanup,reveal,select:selectLine};
