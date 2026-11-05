#!/usr/bin/env node
// Invoked only by the disposable offline supervisor after its local bootstrap.
import { chromium } from '@playwright/test';
const browser=await chromium.launch({headless:true});
try {
  const context=await browser.newContext({baseURL:'http://127.0.0.1:5173'});
  const response=await context.request.post('/api/v1/dev/login',{data:{email:'owner@foilbury.local'}});
  if(response.status()!==200) throw new Error('Synthetic local owner login failed.');
  const page=await context.newPage();
  await page.goto('/play/draw');
  await page.getByLabel('Choose a capsule').selectOption('cabinet-draw');
  await page.getByRole('button',{name:/Draw for/}).click();
  await page.getByRole('link',{name:/Inspect this copy/i}).waitFor({timeout:20000});
  await context.close();
} finally { await browser.close(); }
