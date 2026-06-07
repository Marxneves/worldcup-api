import * as cheerio from 'cheerio'
import cron from 'node-cron'

interface GameResult {
  gameNumber: number
  score1: number
  score2: number
}

export async function fetchResultsFromGlobo(): Promise<GameResult[]> {
  const response = await fetch('https://ge.globo.com/futebol/copa-do-mundo/', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; WorldCupBot/1.0)',
      'Accept': 'text/html,application/xhtml+xml',
    },
  })

  if (!response.ok) throw new Error(`HTTP ${response.status}`)

  const html = await response.text()
  const $ = cheerio.load(html)
  const results: GameResult[] = []

  // GE Globo markup — may require updates as the site changes
  $('.placar-jogo, [class*="placar"], [class*="score"]').each((_, el) => {
    const text = $(el).text().trim()
    const match = text.match(/(\d+)\s*[x×]\s*(\d+)/)
    if (match) {
      const score1 = parseInt(match[1])
      const score2 = parseInt(match[2])
      if (!isNaN(score1) && !isNaN(score2)) {
        // Game number mapping would require more specific selectors
        // This is a best-effort scraper; admin manual entry is the fallback
        results.push({ gameNumber: -1, score1, score2 })
      }
    }
  })

  return results.filter(r => r.gameNumber > 0)
}

export function scheduleScraper() {
  // Runs every 30 minutes during the World Cup (June 11 – June 27)
  cron.schedule('*/30 * * * *', async () => {
    const now = new Date()
    const start = new Date('2026-06-11')
    const end = new Date('2026-06-28')
    if (now < start || now > end) return

    console.log('[scraper] Attempting to fetch results from GE Globo...')
    try {
      const results = await fetchResultsFromGlobo()
      console.log(`[scraper] Found ${results.length} results`)
    } catch (err) {
      console.error('[scraper] Failed:', err)
    }
  })
}
