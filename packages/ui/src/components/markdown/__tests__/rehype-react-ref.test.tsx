import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import type { Element, Root } from 'hast'
import { rehypeReactRef } from '../rehype-react-ref'

function markdownTree(text: string, safe = true) {
  return ReactMarkdown({
    children: text,
    rehypePlugins: safe ? [rehypeRaw, rehypeReactRef] : [rehypeRaw],
  })
}

function refsInTree(node: React.ReactNode): unknown[] {
  if (Array.isArray(node)) return node.flatMap(refsInTree)
  if (!React.isValidElement(node)) return []
  const ref = (node as React.ReactElement & { ref: unknown }).ref
  return [...(ref == null ? [] : [ref]), ...refsInTree(node.props.children)]
}

describe('raw HTML cannot supply React refs', () => {
  it('covers the restored-session trigger before and after JSX conversion', () => {
    const text = "Ticket: <full ref>"
    expect(refsInTree(markdownTree(text, false))).toEqual([''])
    expect(refsInTree(markdownTree(text))).toEqual([])
  })

  it.each(['ref', 'REF', 'ReF'])('removes %s on nested raw HTML while preserving body and ordinary attributes', (attribute) => {
    const tree = markdownTree(`<section class="proof"><span ${attribute}="external" title="kept">body</span></section>`)
    expect(refsInTree(tree)).toEqual([])
    const html = renderToStaticMarkup(tree)
    expect(html).toContain('<section class="proof">')
    expect(html).toContain('<span title="kept">body</span>')
  })

  it('retains normal markdown, escaped placeholders and fenced code', () => {
    const html = renderToStaticMarkup(markdownTree('**bold** and &lt;full ref&gt;\n\n```html\n<span ref="example">text</span>\n```'))
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('&lt;full ref&gt;')
    expect(html).toContain('&lt;span ref=&quot;example&quot;&gt;text&lt;/span&gt;')
  })

  it('leaves refs from code-owned components intact', () => {
    const ref = React.createRef<HTMLSpanElement>()
    let rendered: (React.ReactElement & { ref: unknown }) | undefined
    const tree = ReactMarkdown({
      children: '<span ref="untrusted">text</span>',
      rehypePlugins: [rehypeRaw, rehypeReactRef],
      components: { span: ({ children }) => {
        rendered = <span ref={ref}>{children}</span> as React.ReactElement & { ref: unknown }
        return rendered
      } },
    })
    expect(refsInTree(tree)).toEqual([])
    expect(renderToStaticMarkup(tree)).toContain('<span>text</span>')
    expect(rendered?.ref).toBe(ref)
  })

  it('also strips alternate property casing in supplied HAST without changing other properties', () => {
    const tree: Root = { type: 'root', children: [{ type: 'element', tagName: 'div', properties: { ref: '', ReF: 'x', 'data-ref': 'kept' }, children: [{ type: 'text', value: 'body' }] }] }
    rehypeReactRef()(tree)
    expect(tree.children[0]).toMatchObject({ properties: { 'data-ref': 'kept' }, children: [{ type: 'text', value: 'body' }] })
    expect(Object.keys((tree.children[0] as Element).properties)).toEqual(['data-ref'])
  })
})
