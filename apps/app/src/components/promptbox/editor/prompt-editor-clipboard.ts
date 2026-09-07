import {
  DOMSerializer,
  type DOMOutputSpec,
  type Fragment,
} from "@tiptap/pm/model";

class PromptEditorClipboardSerializer extends DOMSerializer {
  override serializeFragment(
    fragment: Fragment,
    options: { document?: Document } = {},
    target?: HTMLElement | DocumentFragment,
  ): DocumentFragment | HTMLElement {
    const firstChild = fragment.firstChild;
    if (firstChild === null) {
      return super.serializeFragment(fragment, options, target);
    }

    const schema = firstChild.type.schema;
    const nodes = DOMSerializer.nodesFromSchema(schema);
    nodes.paragraph = (): DOMOutputSpec => ["div", 0];
    return new DOMSerializer(
      nodes,
      DOMSerializer.marksFromSchema(schema),
    ).serializeFragment(fragment, options, target);
  }
}

export const promptEditorClipboardSerializer =
  new PromptEditorClipboardSerializer({}, {});
