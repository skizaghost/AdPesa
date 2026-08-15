const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// PostgreSQL Connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/adpesa'
});

// -------------------------------------------------------------
// CAMPAIGN ENDPOINTS
// -------------------------------------------------------------

// Create a new Ad Campaign (Advertiser)
app.post('/api/campaigns', async (req, res) => {
    const { advertiser_id, title, description, media_url, budget, pay_per_action, total_actions_needed } = req.body;
    try {
        const query = `
            INSERT INTO campaigns (advertiser_id, title, description, media_url, budget, pay_per_action, total_actions_needed)
            VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *;
        `;
        const values = [advertiser_id, title, description, media_url, budget, pay_per_action, total_actions_needed];
        const result = await pool.query(query, values);
        res.status(201).json({ success: true, campaign: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get Active Campaigns for Earners
app.get('/api/campaigns', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM campaigns WHERE status = 'active' AND actions_completed < total_actions_needed");
        res.json({ success: true, campaigns: result.rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// -------------------------------------------------------------
// TASK SUBMISSION & APPROVAL
// -------------------------------------------------------------

// Submit Proof for a Campaign Task
app.post('/api/tasks/submit', async (req, res) => {
    const { campaign_id, earner_id, proof_url } = req.body;
    try {
        const query = `
            INSERT INTO task_submissions (campaign_id, earner_id, proof_url)
            VALUES ($1, $2, $3) RETURNING *;
        `;
        const result = await pool.query(query, [campaign_id, earner_id, proof_url]);
        res.status(201).json({ success: true, task: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Approve Task & Credit Earner Wallet
app.post('/api/tasks/approve', async (req, res) => {
    const { submission_id } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Get submission details
        const subRes = await client.query('SELECT * FROM task_submissions WHERE id = $1 AND status = \'pending\'', [submission_id]);
        if (subRes.rows.length === 0) {
            throw new Error('Task submission not found or already processed');
        }
        const submission = subRes.rows[0];

        // Get campaign details
        const campRes = await client.query('SELECT pay_per_action FROM campaigns WHERE id = $1', [submission.campaign_id]);
        const payAmount = campRes.rows[0].pay_per_action;

        // 1. Update Task Status
        await client.query('UPDATE task_submissions SET status = \'approved\', reviewed_at = CURRENT_TIMESTAMP WHERE id = $1', [submission_id]);

        // 2. Increment Campaign Completed Counter
        await client.query('UPDATE campaigns SET actions_completed = actions_completed + 1 WHERE id = $1', [submission.campaign_id]);

        // 3. Credit Earner Wallet
        await client.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [payAmount, submission.earner_id]);

        // 4. Log Transaction
        await client.query(
            'INSERT INTO transactions (user_id, amount, transaction_type, status) VALUES ($1, $2, \'earning\', \'completed\')',
            [submission.earner_id, payAmount]
        );

        await client.query('COMMIT');
        res.json({ success: true, message: 'Task approved and wallet credited successfully' });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`AdPesa API running on port ${PORT}`));
