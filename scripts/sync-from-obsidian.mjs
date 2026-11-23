#!/usr/bin/env node
/**
 * Sync Obsidian blog drafts → Firefly blog posts
 *
 * Usage: node scripts/sync-from-obsidian.mjs
 *
 * What it does:
 *   1. Scans vault blog folder for .md files
 *   2. Generates/merges frontmatter (title, published, description, tags)
 *   3. Converts Obsidian [[wikilinks]] to standard markdown links
 *   4. Copies attached images to the post directory
 *   5. Writes to src/content/posts/
 */

import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

// === Configuration ===
const OBSIDIAN_BLOG_DIR = path.resolve(ROOT, '../doc/05-knowledge/博客草稿')
const POSTS_DIR = path.resolve(ROOT, 'src/content/posts')
const ATTACHMENTS_DIR = path.resolve(ROOT, '../doc/05-knowledge/博客草稿/attachments')
const DRAFTS_DIR = path.resolve(ROOT, '../doc/05-knowledge/个人博客') // legacy location

const DATE_FORMAT = 'YYYY-MM-DD'

// === Utility ===
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\w一-鿿]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 60)
}

function extractFrontmatterYaml(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return null
  const lines = match[1].split('\n')
  const result = {}
  let currentKey = null
  let currentArray = null

  for (const line of lines) {
    const keyMatch = line.match(/^(\w[\w\s]*?):\s*(.*)/)
    if (keyMatch) {
      const key = keyMatch[1].trim().toLowerCase()
      const value = keyMatch[2].trim()

      if (value.startsWith('[') && value.endsWith(']')) {
        // Inline array: tags: [tag1, tag2]
        currentKey = key
        currentArray = value.slice(1, -1).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''))
        result[key] = currentArray
      } else if (value === '' || value === null) {
        currentKey = key
        currentArray = null
      } else {
        currentKey = key
        currentArray = null
        result[key] = value.replace(/^['"]|['"]$/g, '')
      }
    } else if (currentKey && line.match(/^\s+-\s+/)) {
      // YAML list item
      const item = line.trim().replace(/^-\s+/, '').replace(/^['"]|['"]$/g, '')
      if (!Array.isArray(result[currentKey])) result[currentKey] = []
      result[currentKey].push(item)
    }
  }
  return result
}

function parseMarkdownSections(content) {
  // Extract frontmatter, return { frontmatter, body }
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)/)
  if (fmMatch) {
    return {
      frontmatter: extractFrontmatterYaml(fmMatch[1]),
      body: fmMatch[2].trim()
    }
  }
  return { frontmatter: null, body: content.trim() }
}

function convertWikilinks(text) {
  // Convert [[wikilink]] and [[wikilink|display text]] to [display](wikilink)
  return text.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '[$2]($1)')
    .replace(/\[\[([^\]]+)\]\]/g, (match, page) => {
      const slug = slugify(page)
      return `[${page}](./${slug})`
    })
}

function convertEmbeds(text) {
  // Convert ![[image.png]] to ![image](./attachments/image.png)
  return text.replace(/!\[\[([^\]]+)\]\]/g, (match, filename) => {
    return `![${filename}](./attachments/${filename})`
  })
}

async function extractAttachments(body, postDir, sourceAttachmentsDir) {
  // Find all image references in body and copy them
  const imageRegex = /!\[.*?\]\(\.\/attachments\/([^)]+)\)/g
  const images = []
  let match

  while ((match = imageRegex.exec(body)) !== null) {
    images.push(match[1])
  }

  if (images.length === 0) return

  const destDir = path.join(postDir, 'attachments')
  await fs.mkdir(destDir, { recursive: true })

  for (const img of images) {
    const srcPath = path.join(sourceAttachmentsDir, img)
    const destPath = path.join(destDir, img)
    try {
      await fs.copyFile(srcPath, destPath)
      console.log(`  Copied image: ${img}`)
    } catch (err) {
      console.warn(`  Warning: Could not copy ${img}: ${err.message}`)
    }
  }
}

function generateFrontmatter(title, body, existingFm = {}) {
  const fm = { ...existingFm }

  // Title
  if (!fm.title) {
    fm.title = title || 'Untitled'
  }

  // Published date
  if (!fm.published) {
    fm.published = new Date().toISOString().split('T')[0]
  }

  // Description: extract first meaningful paragraph
  if (!fm.description) {
    const firstPara = body.split('\n\n').find(p => {
      const trimmed = p.trim()
      return trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('>')
    })
    if (firstPara) {
      const text = firstPara.replace(/[#*`_~>\[\]!()]/g, '').trim()
      fm.description = text.length > 120 ? text.substring(0, 120) + '...' : text
    } else {
      fm.description = ''
    }
  }

  // Tags: default to empty array
  if (!fm.tags) fm.tags = []

  // Clean up fields that shouldn't be in frontmatter
  delete fm.created
  delete fm.modified

  return fm
}

function buildFrontmatterString(fm) {
  let result = '---\n'
  for (const [key, value] of Object.entries(fm)) {
    if (Array.isArray(value)) {
      if (value.length === 0) continue
      result += `${key}:\n`
      for (const item of value) {
        result += `  - ${item}\n`
      }
    } else if (value !== null && value !== undefined && value !== '') {
      result += `${key}: '${value}'\n`
    }
  }
  result += '---\n'
  return result
}

async function syncFile(filePath, sourceAttachmentsDir) {
  const filename = path.basename(filePath)
  const nameWithoutExt = filename.replace(/\.md$/, '')
  const slug = slugify(nameWithoutExt) || nameWithoutExt
  const content = await fs.readFile(filePath, 'utf-8')

  console.log(`\nProcessing: ${filename}`)

  // Parse content
  const { frontmatter, body } = parseMarkdownSections(content)

  // Extract title from first heading if not in frontmatter
  let title = frontmatter?.title
  if (!title) {
    const headingMatch = body.match(/^#\s+(.+)$/m)
    title = headingMatch ? headingMatch[1].trim() : nameWithoutExt
  }

  // Generate/merge frontmatter
  const fm = generateFrontmatter(title, body, frontmatter)

  // Convert wikilinks and embeds
  let processedBody = convertWikilinks(body)
  processedBody = convertEmbeds(processedBody)

  // Determine output: use subdirectory if there are attachments
  const hasAttachments = processedBody.includes('./attachments/')
  let postDir, outputPath

  if (hasAttachments) {
    postDir = path.join(POSTS_DIR, slug)
    outputPath = path.join(postDir, 'index.md')
  } else {
    postDir = POSTS_DIR
    outputPath = path.join(POSTS_DIR, `${slug}.md`)
  }

  // Create directory
  await fs.mkdir(postDir, { recursive: true })

  // Copy attachments
  if (hasAttachments && sourceAttachmentsDir) {
    await extractAttachments(processedBody, postDir, sourceAttachmentsDir)
  }

  // Write post
  const finalContent = buildFrontmatterString(fm) + '\n' + processedBody + '\n'
  await fs.writeFile(outputPath, finalContent, 'utf-8')
  console.log(`  Written: ${path.relative(POSTS_DIR, outputPath)}`)
  console.log(`  Title: ${fm.title}`)
  console.log(`  Published: ${fm.published}`)
}

async function scanDirectory(dir) {
  const files = []
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        files.push(...await scanDirectory(fullPath))
      } else if (entry.name.endsWith('.md')) {
        files.push(fullPath)
      }
    }
  } catch (err) {
    // Directory doesn't exist yet
  }
  return files
}

async function main() {
  console.log('=== Obsidian → Firefly Sync ===')
  console.log(`Source: ${OBSIDIAN_BLOG_DIR}`)
  console.log(`Destination: ${POSTS_DIR}`)
  console.log()

  // Ensure posts directory exists
  await fs.mkdir(POSTS_DIR, { recursive: true })

  // Scan for markdown files in both draft locations
  const blogFiles = await scanDirectory(OBSIDIAN_BLOG_DIR)
  const legacyFiles = await scanDirectory(DRAFTS_DIR)
  const allFiles = [...blogFiles, ...legacyFiles]

  // Remove duplicates
  const uniqueFiles = [...new Set(allFiles)]

  if (uniqueFiles.length === 0) {
    console.log('No markdown files found in blog draft folders.')
    console.log(`\nPut your .md files in:`)
    console.log(`  ${OBSIDIAN_BLOG_DIR}`)
    console.log(`  or ${DRAFTS_DIR}`)
    return
  }

  console.log(`Found ${uniqueFiles.length} markdown file(s) to sync.\n`)

  // Determine attachments directory
  let attachmentsDir = ATTACHMENTS_DIR
  if (!await fs.stat(ATTACHMENTS_DIR).catch(() => null)) {
    attachmentsDir = null
  }

  let successCount = 0
  let failCount = 0

  for (const file of uniqueFiles) {
    try {
      await syncFile(file, attachmentsDir)
      successCount++
    } catch (err) {
      console.error(`  ERROR: ${err.message}`)
      failCount++
    }
  }

  console.log(`\n=== Sync complete: ${successCount} succeeded, ${failCount} failed ===`)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
