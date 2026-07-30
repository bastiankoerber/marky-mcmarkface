# Migration notes

<p class="callout">
Read the whole page before starting. The third step is not reversible without a snapshot.
</p>

Docs repositories are full of raw HTML tables, usually because the author needed column spans
that pipe tables cannot express. Rendering passes the block through verbatim, which means every
character of visible text still sits at a known source offset.

<table>
<thead>
  <tr>
    <th>Property</th>
    <th>Replacement value</th>
  </tr>
</thead>
<tbody>
  <tr>
    <td>maxMetadataSize</td>
    <td>A custom limit expressed in bytes, defaulting to 32768.</td>
  </tr>
  <tr>
    <td>retentionWindow</td>
    <td>How long completed instances remain queryable before archival.</td>
  </tr>
</tbody>
</table>

<!-- GENERATED:START — do not edit by hand -->
The section below is regenerated from the source of truth on every release.
<!-- GENERATED:END -->

After the table, ordinary prose resumes and must still anchor correctly. This paragraph exists
precisely to check that the raw block did not swallow the offsets that follow it.
