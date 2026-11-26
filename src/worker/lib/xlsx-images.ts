import JSZip from 'jszip'

/**
 * Locates images embedded in an .xlsx worksheet and maps them back to their row.
 *
 * xlsx stores pictures in xl/media/*, positioned by anchors in xl/drawings/drawingN.xml
 * which reference the media file through a relationship id. So the row -> image link is
 * anchor.row -> r:embed -> rels Target -> xl/media/file.
 */

export interface EmbeddedImage {
  rowNumber: number
  path: string
}

function parseDrawingAnchors(drawingXml: string): Record<number, string> {
  const rowToRel: Record<number, string> = {}
  const anchorRegex = /<(?:\w+:)?(twoCellAnchor|oneCellAnchor|absoluteAnchor)[\s\S]*?<\/(?:\w+:)?\1>/g

  for (const match of drawingXml.matchAll(anchorRegex)) {
    const block = match[0]
    const rowMatch = block.match(/<(?:\w+:)?row>(\d+)<\/(?:\w+:)?row>/)
    const embedMatch = block.match(/r:embed="([^"]+)"/)
    if (!rowMatch || !embedMatch) continue

    const rowIndex = Number.parseInt(rowMatch[1], 10)
    if (Number.isNaN(rowIndex)) continue

    // Drawing anchors are 0-based; sheet rows are 1-based.
    rowToRel[rowIndex + 1] = embedMatch[1]
  }

  return rowToRel
}

function parseRels(relsXml: string): Record<string, string> {
  const map: Record<string, string> = {}
  for (const match of relsXml.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
    map[match[1]] = match[2]
  }
  return map
}

function resolvePath(basePath: string, relativeTarget: string): string {
  const parts = basePath.split('/')
  parts.pop()

  for (const segment of relativeTarget.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      parts.pop()
      continue
    }
    parts.push(segment)
  }

  return parts.join('/')
}

async function resolveWorksheetDrawingPaths(zip: JSZip, sheetName: string): Promise<string[]> {
  const workbookXml = await zip.file('xl/workbook.xml')?.async('text')
  const workbookRelsXml = await zip.file('xl/_rels/workbook.xml.rels')?.async('text')
  if (!workbookXml || !workbookRelsXml) return []

  const sheetRid: Record<string, string> = {}
  for (const match of workbookXml.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"[^>]*\/?>/g)) {
    sheetRid[match[1]] = match[2]
  }

  const rid = sheetRid[sheetName]
  if (!rid) return []

  const workbookRels = parseRels(workbookRelsXml)
  const target = workbookRels[rid]
  if (!target) return []

  const worksheetPath = resolvePath('xl/workbook.xml', target)
  const worksheetXml = await zip.file(worksheetPath)?.async('text')
  if (!worksheetXml) return []

  const drawingRids = Array.from(worksheetXml.matchAll(/<drawing[^>]*r:id="([^"]+)"[^>]*\/?>/g)).map(
    (m) => m[1]
  )
  if (drawingRids.length === 0) return []

  const fileName = worksheetPath.split('/').pop()
  if (!fileName) return []

  const relsXml = await zip.file(`xl/worksheets/_rels/${fileName}.rels`)?.async('text')
  if (!relsXml) return []

  const rels = parseRels(relsXml)
  return drawingRids
    .map((drawingRid) => rels[drawingRid])
    .filter(Boolean)
    .map((drawingTarget) => resolvePath(worksheetPath, drawingTarget))
}

/** Returns the row -> media-path index for a sheet, without reading image bytes. */
export async function indexEmbeddedImages(zip: JSZip, sheetName: string): Promise<EmbeddedImage[]> {
  const worksheetDrawings = await resolveWorksheetDrawingPaths(zip, sheetName)
  const drawingPaths = worksheetDrawings.length
    ? worksheetDrawings
    : Object.keys(zip.files).filter((path) => /^xl\/drawings\/drawing\d+\.xml$/i.test(path))

  const seen = new Set<number>()
  const images: EmbeddedImage[] = []

  for (const drawingPath of drawingPaths) {
    const drawingXml = await zip.file(drawingPath)?.async('text')
    const relsXml = await zip
      .file(drawingPath.replace('xl/drawings/', 'xl/drawings/_rels/') + '.rels')
      ?.async('text')
    if (!drawingXml || !relsXml) continue

    const rowToRel = parseDrawingAnchors(drawingXml)
    const relToTarget = parseRels(relsXml)

    for (const [rowString, relId] of Object.entries(rowToRel)) {
      const target = relToTarget[relId]
      if (!target) continue

      const rowNumber = Number.parseInt(rowString, 10)
      if (seen.has(rowNumber)) continue

      const mediaPath = resolvePath(drawingPath, target)
      if (!zip.file(mediaPath)) continue

      seen.add(rowNumber)
      images.push({ rowNumber, path: mediaPath })
    }
  }

  return images.sort((a, b) => a.rowNumber - b.rowNumber)
}

export async function readImageBytes(zip: JSZip, path: string): Promise<Uint8Array | null> {
  const file = zip.file(path)
  if (!file) return null
  return file.async('uint8array')
}
