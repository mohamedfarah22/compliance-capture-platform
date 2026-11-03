// Gold Phase 8a UAT, photos and camera (spec 4.5, 5.4): whatever the staff member uses, the browser hands on a JPEG of at most 1600 px.
import { expect, test } from '@playwright/test'
import { makeImage, openAs, sighted, upload } from './support.js'

let ctx
let page
const imgs = {}

test.beforeAll(async ({ browser }) => {
  ctx = await openAs(browser, 's1')
  page = ctx.page
  await page.goto('/gold')
  imgs.png = await makeImage(page, { width: 3000, height: 2000, type: 'image/png' })
  imgs.webp = await makeImage(page, { width: 2400, height: 1200, type: 'image/webp' })
  imgs.jpg = await makeImage(page, { width: 2400, height: 1800, type: 'image/jpeg' })
  imgs.tall = await makeImage(page, { width: 1000, height: 3200, type: 'image/jpeg' })
  imgs.smallJpg = await makeImage(page, { width: 800, height: 500, type: 'image/jpeg' })
  imgs.smallPng = await makeImage(page, { width: 400, height: 300, type: 'image/png' })
})
test.afterAll(async () => ctx?.context.close())

test.beforeEach(async () => {
  await page.goto('/gold/customers/new')
  await expect(page.getByRole('heading', { name: 'New customer' })).toBeVisible()
})

const preview = (label) => page.getByAltText(`${label} preview`)
const handedOn = async (label) => {
  await expect(preview(label)).toBeVisible()
  return preview(label).evaluate(async (el) => {
    await el.decode()
    return { mime: el.src.slice(5, el.src.indexOf(';')), width: el.naturalWidth, height: el.naturalHeight }
  })
}

test('8a.36 — PNG, WebP and JPEG over 1600 px are handed on as image/jpeg within 1600 px, aspect kept; a small file is not enlarged', async () => {
  const cases = [
    ['png', 'image/png', 'a.png', { mime: 'image/jpeg', width: 1600, height: 1067 }],
    ['webp', 'image/webp', 'a.webp', { mime: 'image/jpeg', width: 1600, height: 800 }],
    ['jpg', 'image/jpeg', 'a.jpg', { mime: 'image/jpeg', width: 1600, height: 1200 }],
    ['tall', 'image/jpeg', 'a.jpg', { mime: 'image/jpeg', width: 500, height: 1600 }],
    ['smallJpg', 'image/jpeg', 'a.jpg', { mime: 'image/jpeg', width: 800, height: 500 }],
    ['smallPng', 'image/png', 'a.png', { mime: 'image/jpeg', width: 400, height: 300 }],
  ]
  for (const [key, mimeType, name, expected] of cases) {
    await upload(page, 'ID front', imgs[key], { name, mimeType })
    await expect.poll(() => handedOn('ID front'), key).toEqual(expected)
  }
})

test('8a.37 — a file the browser cannot decode (a HEIC renamed, a text file) is not accepted, with a message, and the form is not submitted', async () => {
  const sent = []
  page.on('request', (r) => r.url().includes('/functions/v1/gold-create-customer') && sent.push(r))
  for (const [name, mimeType] of [
    ['photo.heic', 'image/heic'],
    ['notes.heic', 'text/plain'],
  ]) {
    await upload(page, 'ID front', Buffer.from('this is not a picture'), { name, mimeType })
    await expect(page.getByRole('alert').filter({ hasText: 'That photo could not be read. Take it again, or choose a JPEG.' })).toBeVisible()
    await expect(preview('ID front')).toHaveCount(0)
    await expect(page.getByText('No photo yet').first()).toBeVisible()
  }
  await sighted(page).check()
  await page.getByRole('button', { name: 'Create customer' }).click()
  // the slot keeps saying the photo could not be read, and nothing is sent
  await expect(page.getByRole('alert').filter({ hasText: 'That photo could not be read.' })).toBeVisible()
  expect(sent).toHaveLength(0)
  // a good photo afterwards clears the message
  await upload(page, 'ID front', imgs.smallJpg)
  await expect(preview('ID front')).toBeVisible()
  await expect(page.getByText('That photo could not be read.')).toHaveCount(0)
})

test('8a.38 — with the camera blocked the dialog says so; Upload still works; Escape and Cancel close it and give focus back', async () => {
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('blocked', 'NotAllowedError'))
  })
  const open = page.getByRole('group', { name: 'ID front' }).getByRole('button', { name: 'Take photo' })
  const dialog = page.getByRole('dialog', { name: 'ID front' })
  await open.click()
  await expect(dialog.getByRole('alert')).toContainText('The camera is unavailable')
  await expect(dialog.getByRole('alert')).toContainText('choose Upload')
  await expect(dialog.getByRole('button', { name: 'Take photo' })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(open).toBeFocused()

  await open.click()
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(open).toBeFocused()

  await upload(page, 'ID front', imgs.smallJpg)
  await expect(preview('ID front')).toBeVisible()
})

test('8a.60 — a 4000 x 3000 camera frame is handed on as a JPEG of 1600 x 1200 (added by UAT)', async () => {
  // A live stream whose frames are 4000 x 3000, in place of the fake device (a phone or iPad camera can be this large).
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement('canvas')
      canvas.width = 4000
      canvas.height = 3000
      const ctx = canvas.getContext('2d')
      const draw = () => {
        ctx.fillStyle = `hsl(${(Date.now() / 20) % 360} 70% 50%)`
        ctx.fillRect(0, 0, 4000, 3000)
        ctx.fillStyle = '#fff'
        ctx.font = '300px sans-serif'
        ctx.fillText('CAMERA 4000x3000', 200, 1500)
      }
      draw()
      setInterval(draw, 100)
      return canvas.captureStream(10)
    }
  })
  await page.getByRole('group', { name: 'ID front' }).getByRole('button', { name: 'Take photo' }).click()
  const dialog = page.getByRole('dialog', { name: 'ID front' })
  await expect(dialog.getByRole('button', { name: 'Take photo' })).toBeEnabled()
  const frame = await dialog.locator('video').evaluate((v) => [v.videoWidth, v.videoHeight])
  expect(frame).toEqual([4000, 3000])
  await dialog.getByRole('button', { name: 'Take photo' }).click()
  await expect(dialog).toHaveCount(0)
  expect(await handedOn('ID front')).toEqual({ mime: 'image/jpeg', width: 1600, height: 1200 })
})
