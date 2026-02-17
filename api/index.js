// Simple API endpoint for Vercel
export default function handler(req, res) {
  res.status(200).json({
    status: 'ok',
    message: 'MVP Test - Faceless YouTube Pipeline',
    timestamp: new Date().toISOString(),
    endpoints: {
      health: '/api/health',
      version: '/api/version'
    }
  });
}
