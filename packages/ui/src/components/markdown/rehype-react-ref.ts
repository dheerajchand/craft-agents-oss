import type { Root } from 'hast'
import { visit } from 'unist-util-visit'

/**
 * Raw HTML attributes are data, not React instance refs. For example, prose such
 * as `<full ref>` becomes a string ref and crashes React's client renderer.
 * Run after rehype-raw, before react-markdown creates React elements. This does
 * not affect refs created by our own React components or strip supported HTML.
 */
export function rehypeReactRef() {
  return (tree: Root): void => {
    visit(tree, 'element', (node) => {
      for (const name of Object.keys(node.properties)) {
        if (name.toLowerCase() === 'ref') delete node.properties[name]
      }
    })
  }
}
