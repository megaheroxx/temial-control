// Puts the current version on the download buttons and links the APK of the latest release.
// Without it the page still links to the releases.
(async () => {
  try {
    const res = await fetch('https://api.github.com/repos/megaheroxx/temial-control/releases/latest', {
      headers: { Accept: 'application/vnd.github+json' },
    })
    if (!res.ok) return
    const release = await res.json()
    const stable = document.getElementById('download-stable')
    stable.textContent = `Download ${release.tag_name}`
    stable.href = release.html_url
    const apk = release.assets.find((asset) => asset.name.endsWith('.apk'))
    if (apk) {
      const button = document.getElementById('download-apk')
      button.textContent = `Download APK ${release.tag_name}`
      button.href = apk.browser_download_url
    }
  } catch {
    // Offline or rate limited: keep the static links.
  }
})()
