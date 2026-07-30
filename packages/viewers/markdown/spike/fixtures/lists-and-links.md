# Review workflow

1. Open the pull request and read it as a document rather than as a diff.
2. Leave comments where the prose is wrong, not where the Markdown is ugly.
   - Formatting belongs in a linter.
   - Terminology belongs in review.
     - Especially names of things users will type.
3. Submit once, with a summary, rather than dripping comments over an afternoon.

## Reference

- The [handbook](https://example.test/handbook) is the source of truth for terminology.
- The [style guide][style] covers voice and tense.
- Older decisions live in the [archive](https://example.test/archive "Decision archive").

Escaped characters appear more often than you would like: a literal \*asterisk\*, a backslash
before a \_underscore\_, and an ampersand written as &amp; rather than as itself. Each of these
makes the rendered text differ from its source, which is exactly the case where an anchor must
widen rather than guess.

A footnote[^why] is another construct that separates rendered position from source position.

[^why]: Because the definition lives at the bottom of the file while the marker lives inline.

[style]: https://example.test/style-guide
