export default function handler(req, res) {
  console.log('processing...')
  res.status(200).json({
    now: new Date().toISOString()
  });
}