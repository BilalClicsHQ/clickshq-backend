import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth';
import { getValidSalesforceToken, salesforceApi } from '../services/salesforceService';

const router = Router();

// Helper to get token + instance URL
async function getSfAuth(req: Request, res: Response): Promise<{ accessToken: string; instanceUrl: string } | null> {
  const user = req.user as any;
  if (!user?.id) {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED' } });
    return null;
  }
  try {
    return await getValidSalesforceToken(user.id);
  } catch (err: any) {
    res.status(403).json({ success: false, error: { code: 'NOT_CONNECTED', message: err.message } });
    return null;
  }
}

// ─── User Info ──────────────────────────────────────────────────────────────
router.get('/user', requireAuth, async (req: Request, res: Response) => {
  try {
    const auth = await getSfAuth(req, res);
    if (!auth) return;
    const loginUrl = process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com';
    const userRes = await fetch(`${auth.instanceUrl}/services/oauth2/userinfo`, {
      headers: { 'Authorization': `Bearer ${auth.accessToken}` },
    });
    const userInfo = await userRes.json();
    return res.json({ success: true, data: userInfo });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'SALESFORCE_API_ERROR', message: err.message } });
  }
});

// ─── Contacts ───────────────────────────────────────────────────────────────
router.get('/contacts', requireAuth, async (req: Request, res: Response) => {
  try {
    const auth = await getSfAuth(req, res);
    if (!auth) return;
    const limit = Math.min(Number(req.query.limit) || 25, 100);
    const offset = Number(req.query.offset) || 0;
    const query = `SELECT Id, FirstName, LastName, Email, Phone, Account.Name FROM Contact ORDER BY LastName ASC LIMIT ${limit} OFFSET ${offset}`;
    const data = await salesforceApi(auth.accessToken, auth.instanceUrl, `/query?q=${encodeURIComponent(query)}`);
    return res.json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'SALESFORCE_API_ERROR', message: err.message } });
  }
});

// ─── Leads ──────────────────────────────────────────────────────────────────
router.get('/leads', requireAuth, async (req: Request, res: Response) => {
  try {
    const auth = await getSfAuth(req, res);
    if (!auth) return;
    const limit = Math.min(Number(req.query.limit) || 25, 100);
    const offset = Number(req.query.offset) || 0;
    const query = `SELECT Id, FirstName, LastName, Email, Company, Status, Phone FROM Lead ORDER BY CreatedDate DESC LIMIT ${limit} OFFSET ${offset}`;
    const data = await salesforceApi(auth.accessToken, auth.instanceUrl, `/query?q=${encodeURIComponent(query)}`);
    return res.json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'SALESFORCE_API_ERROR', message: err.message } });
  }
});

// ─── Opportunities ──────────────────────────────────────────────────────────
router.get('/opportunities', requireAuth, async (req: Request, res: Response) => {
  try {
    const auth = await getSfAuth(req, res);
    if (!auth) return;
    const limit = Math.min(Number(req.query.limit) || 25, 100);
    const offset = Number(req.query.offset) || 0;
    const query = `SELECT Id, Name, StageName, Amount, CloseDate, Account.Name FROM Opportunity ORDER BY CloseDate DESC LIMIT ${limit} OFFSET ${offset}`;
    const data = await salesforceApi(auth.accessToken, auth.instanceUrl, `/query?q=${encodeURIComponent(query)}`);
    return res.json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'SALESFORCE_API_ERROR', message: err.message } });
  }
});

// ─── Accounts ───────────────────────────────────────────────────────────────
router.get('/accounts', requireAuth, async (req: Request, res: Response) => {
  try {
    const auth = await getSfAuth(req, res);
    if (!auth) return;
    const limit = Math.min(Number(req.query.limit) || 25, 100);
    const offset = Number(req.query.offset) || 0;
    const query = `SELECT Id, Name, Industry, Phone, Website, BillingCity FROM Account ORDER BY Name ASC LIMIT ${limit} OFFSET ${offset}`;
    const data = await salesforceApi(auth.accessToken, auth.instanceUrl, `/query?q=${encodeURIComponent(query)}`);
    return res.json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'SALESFORCE_API_ERROR', message: err.message } });
  }
});

// ─── SOQL Query (generic) ───────────────────────────────────────────────────
router.get('/query', requireAuth, async (req: Request, res: Response) => {
  try {
    const auth = await getSfAuth(req, res);
    if (!auth) return;
    const q = req.query.q as string;
    if (!q) return res.status(400).json({ success: false, error: { code: 'MISSING_QUERY', message: 'Query parameter q is required' } });
    const data = await salesforceApi(auth.accessToken, auth.instanceUrl, `/query?q=${encodeURIComponent(q)}`);
    return res.json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'SALESFORCE_API_ERROR', message: err.message } });
  }
});

export default router;
