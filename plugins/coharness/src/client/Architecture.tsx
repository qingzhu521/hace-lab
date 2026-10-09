import { useMemo, useState } from 'react';
import { architectureDocument, sanitizeArchitecture } from './architecture-document.ts';
import css from './panel.module.css';
export function Architecture({html}:{html?:string}) {
  const [expanded,setExpanded]=useState(false);
  const document=useMemo(()=>html?architectureDocument(sanitizeArchitecture(html)):'',[html]);
  if(!html)return <p className={css.warning}>这份旧概览没有架构 HTML。模型将在重新生成时补充架构页面。</p>;
  return <section className={expanded?css.architectureExpanded:css.architecture} aria-label="模型生成的架构页面">
    <header><div><strong>项目架构</strong><span>模型根据文件依据生成 · 尚未运行验证</span></div><button onClick={()=>setExpanded(value=>!value)}>{expanded?'收起架构':'展开架构'}</button></header>
    <iframe title="模型生成的项目架构" sandbox="" referrerPolicy="no-referrer" srcDoc={document} />
  </section>;
}
