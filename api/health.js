// Health check endpoint
export default function handler(req, res) {
  res.status(200).json({
    status: 'healthy',
    service: 'mvp-test',
    timestamp: new Date().toISOString()
  });
}
