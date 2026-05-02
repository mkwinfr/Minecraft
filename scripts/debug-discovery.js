(async () => {
  const response = await fetch('https://www.minecraft.net/en-us/download/server/bedrock', {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });

  const html = await response.text();
  const match = html.match(/bedrockdedicatedserver[^"'\s<>]+/gi);
  console.log('status', response.status, 'length', html.length, 'count', match ? match.length : 0);
  if (match && match.length > 0) {
    console.log(match.slice(0, 10));
  }
})();
