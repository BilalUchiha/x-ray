import { Fragment, type ReactNode } from 'react';

/** Minimal markdown: fenced code, headings, lists, inline code and emphasis. */
export function Markdown({ text }: { text: string }) {
  const lines = text.split(/\r\n|\r|\n/);
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (line.trim().startsWith('```')) {
      const language = line.trim().slice(3).trim();
      const body: string[] = [];
      index++;
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        body.push(lines[index]);
        index++;
      }
      index++; // closing fence
      blocks.push(
        <pre key={`code-${index}`} data-language={language || undefined}>
          <code>{body.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    if (/^#{1,4}\s/.test(line)) {
      const level = line.match(/^#+/)?.[0].length ?? 1;
      blocks.push(
        <div key={`h-${index}`} style={{ fontWeight: 600, marginBottom: 6, fontSize: level <= 2 ? 13.5 : 12.5 }}>
          {inline(line.replace(/^#+\s*/, ''))}
        </div>,
      );
      index++;
      continue;
    }

    if (/^\s*[-*+]\s/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*+]\s/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*+]\s/, ''));
        index++;
      }
      blocks.push(
        <ul key={`ul-${index}`} style={{ margin: '0 0 8px', paddingLeft: 18 }}>
          {items.map((item, i) => (
            <li key={i}>{inline(item)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    if (/^\s*\d+[.)]\s/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+[.)]\s/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+[.)]\s/, ''));
        index++;
      }
      blocks.push(
        <ol key={`ol-${index}`} style={{ margin: '0 0 8px', paddingLeft: 20 }}>
          {items.map((item, i) => (
            <li key={i}>{inline(item)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    if (line.trim() === '') {
      index++;
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() !== '' && !/^\s*([-*+]|\d+[.)])\s/.test(lines[index]) && !lines[index].trim().startsWith('```') && !/^#{1,4}\s/.test(lines[index])) {
      paragraph.push(lines[index]);
      index++;
    }
    blocks.push(<p key={`p-${index}`}>{inline(paragraph.join(' '))}</p>);
  }

  return <>{blocks}</>;
}

function inline(text: string): ReactNode {
  const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean);
  return (
    <>
      {tokens.map((token, index) => {
        if (token.startsWith('`') && token.endsWith('`') && token.length > 2) {
          return <code key={index}>{token.slice(1, -1)}</code>;
        }
        if (token.startsWith('**') && token.endsWith('**') && token.length > 4) {
          return <strong key={index}>{token.slice(2, -2)}</strong>;
        }
        return <Fragment key={index}>{token}</Fragment>;
      })}
    </>
  );
}
