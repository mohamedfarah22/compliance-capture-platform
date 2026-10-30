# UAT: TTR report fixes (Melbourne time, sole trader, conducting person aliases)

**Purpose:** prove three fixes to what the TTR report sends to AUSTRAC:
1. `txnDate`/`txnTime` are Melbourne local time, not UTC
2. Individuals are asked "Is this person a sole trader?" and a sole trader's ABN reaches the report
3. The conducting person's aliases reach the report

This sheet does not re-prove ID verification or general schema coverage. [dev-test-sheet.md](dev-test-sheet.md) covers that.

| | |
|---|---|
| Environment | ________ |
| Build/commit | ________ |
| Run by / date | ________ |

**Setup.** The app build includes these changes, and the report function is deployed:
`npx supabase functions deploy generate-austrac-report`

**Conventions.**
- `<today>` means today's date. Country is `Australia` / `AU` unless stated. Any small JPG works for ID images.
- Run every transaction **during business hours on the same day**, then generate the report **once** at the end.
  There is one batch per day. If you need to rebuild it, use **Regenerate** on the batch page.
- Steps marked ⚠ are where the old bug showed.

**Timing.** About 40 minutes.

---

## T1 ⚠ Sole trader with ABN, 9:35 am sale

**Start Transaction**
- Scenario: `Sell bullion to customer`
- Transaction reference: `UAT-TTR-001`
- Transaction date and time: `<today>`, `09:35 am`
- Click **Start transaction**

**Add Customers / Parties:** click **Create new customer**, choose **Individual**
- First name: `Sophie`
- Last name: `Trader`
- Date of birth: `14/03/1984`
- Click **Save customer**
- Self-conducted question: **No**
- Click **Continue**

**Transaction & Cash Details**
- Cash amount: `12000`
- Click **Continue**

**Party Details** (full name and date of birth are pre-filled)
- Street address: `12 Smith St`
- Suburb: `Fitzroy`
- State: `VIC`
- Postcode: `3065`
- Phone number: `0400111222`
- Occupation or principal activity: `Jewellery maker`
- Gender: `Female`
- Leave Citizenship country `AU` and Tax residency country `AU`

Validation checks on this screen:

| # | Do this | Expect |
|---|---|---|
| V1 | Leave **Is this person a sole trader?** on `Select an option`, click **Continue** | ☐ Error: "Select whether this person is a sole trader." ☐ No ABN field on screen |
| V2 | Choose `Yes` | ☐ ABN field appears, with helper "Leave blank if they don't have an ABN." |
| V3 | ABN: `12 345 678 90`, click **Continue** | ☐ Error: "ABN must be exactly 11 digits." |
| V4 | Clear the ABN, type `12345678901`, then change the answer to `No` | ☐ ABN field disappears |
| V5 | Change back to `Yes` | ☐ ABN field is empty (it was cleared) |

Then finish the screen:
- Is this person a sole trader?: `Yes`
- ABN: `12345678901`
- Click **Continue**

**Conducting Person**
- Is a different person conducting the transaction on behalf of a party?: **No**
- Click **Continue**

**Reload check (saved to the database)**

| # | Do this | Expect |
|---|---|---|
| V6 | **Close the browser tab. Do not click Exit, which deletes the draft.** Open the app in a new tab, click Start Transaction and enter reference `UAT-TTR-001` | ☐ "Existing draft found — fields pre-filled." |
| V7 | Continue through to **Party Details** (answer **No** to the self-conducted question again) | ☐ Sole trader shows `Yes` ☐ ABN shows `12345678901` |

Click **Continue** back to Conducting Person (**No**), then **Continue**.

**ID Verification** (Sophie Trader)
- Verification method: `Sighted original document`
- Document or data-source type: `Driver licence`
- Document or reference number: `UATTTR101`
- Issuer: `VicRoads`
- Country: `AU`
- Has expiry: `Yes`, expiry `11/04/2030`
- Capture front and back
- Click **Continue**

**Review / Validate / Submit:** ☐ "This transaction is ready to be completed." Click **Complete**. ☐ Succeeds

---

## T2 ⚠ Not a sole trader, conducting person with an alias, 2:20 pm sale

**Start Transaction**
- Scenario: `Sell bullion to customer`
- Transaction reference: `UAT-TTR-002`
- Transaction date and time: `<today>`, `02:20 pm`

**Add Customers / Parties:** click **Create new customer** (Individual)
- First name: `Oliver`
- Last name: `Brennan`
- Date of birth: `02/11/1979`
- Click **Save customer**
- Self-conducted question: **No**
- Click **Continue**

**Transaction & Cash Details**
- Cash amount: `15000`

**Party Details**
- Street address: `40 Lygon St`
- Suburb: `Carlton`
- State: `VIC`
- Postcode: `3053`
- Phone number: `0400333444`
- Occupation or principal activity: `Accountant`
- Gender: `Male`
- Is this person a sole trader?: `No` (☐ no ABN field shown)
- Click **Continue**

**Conducting Person**
- Is a different person conducting the transaction on behalf of a party?: **Yes**
- Customer / party being represented: `Oliver Brennan`
- Full legal name: `Grace Holloway`
- Other names or aliases: click **+ Add alias**, type `Gracie Holloway`
- Is the date of birth known?: **Yes**
- Date of birth: `22/09/1990`
- Residential address:
  - Street address: `8 Collins St`
  - Suburb: `Melbourne`
  - State: `VIC`
  - Postcode: `3000`
  - Country: `Australia`
- Phone number: `0400555666`
- Occupation, job title, or principal activity: `Executive assistant`
- Relationship to the customer / party: `Agent`
- Authority to act: `Signed letter of authority`
- Is the conducting person an employee of the customer / party?: **No**
- Is the conducting person acting through another entity?: **No**
- Click **Continue**

**ID Verification** (verify both people)

| Field | Oliver Brennan | Grace Holloway |
|---|---|---|
| Verification method | `Sighted original document` | `Sighted original document` |
| Document or data-source type | `Driver licence` | `Passport` |
| Document or reference number | `UATTTR102` | `PA1234567` |
| Issuer | `VicRoads` | `Australian Passport Office` |
| Country | `AU` | `AU` |
| Expiry | `Yes`, `02/11/2031` | `Yes`, `22/09/2033` |

Capture front (and back for the licence). Click **Continue**.

**Review / Validate / Submit:** Click **Complete**. ☐ Succeeds

---

## T3 ⚠ Sole trader with no ABN, 8:05 am sale

**Start Transaction**
- Scenario: `Buy bullion from customer`
- Transaction reference: `UAT-TTR-003`
- Transaction date and time: `<today>`, `08:05 am`

**Add Customers / Parties:** click **Create new customer** (Individual)
- First name: `Hannah`
- Last name: `Kerr`
- Date of birth: `30/06/1992`
- Click **Save customer**
- Self-conducted question: **No**
- Click **Continue**

**Transaction & Cash Details**
- Cash amount: `11000`

**Party Details**
- Street address: `3 Bay Rd`
- Suburb: `Sandringham`
- State: `VIC`
- Postcode: `3191`
- Phone number: `0400777888`
- Occupation or principal activity: `Market stallholder`
- Gender: `Female`
- Is this person a sole trader?: `Yes`
- ABN: leave **blank**
- Click **Continue** (☐ no error)

**Conducting Person:** **No**

**ID Verification** (Hannah Kerr): same as T1, but Document or reference number `UATTTR103`

**Review / Validate / Submit:** Click **Complete**. ☐ Succeeds

---

## R1 Generate and check the report

**Generate once**, after T1–T3 are complete:

```
POST https://<project>.supabase.co/functions/v1/generate-austrac-report
Authorization: Bearer <sb_secret_...>
apikey:        <same key>
Content-Type:  application/json

{"reportDate": "<today, YYYY-MM-DD>"}
```

Open the batch (Reports page or the approval email link) and click **Download XML**.
**Do not lodge this file with AUSTRAC.**

Find each transaction by its `<txnRefNo>`:

| # | Transaction | Look for | Pass |
|---|---|---|---|
| X1 ⚠ | `UAT-TTR-001` | `<txnDate><today></txnDate><txnTime>09:35:00</txnTime>` | ☐ |
| X2 ⚠ | `UAT-TTR-003` | `<txnDate><today></txnDate><txnTime>08:05:00</txnTime>` | ☐ |
| X3 | `UAT-TTR-002` | `<txnDate><today></txnDate><txnTime>14:20:00</txnTime>` | ☐ |
| X4 ⚠ | `UAT-TTR-001` customer | `<isSoleTrader>Y</isSoleTrader><isAbnHolder>Y</isAbnHolder><abn>12345678901</abn>` | ☐ |
| X5 | `UAT-TTR-003` customer | `<isSoleTrader>Y</isSoleTrader><isAbnHolder>N</isAbnHolder>`, and no `<abn>` | ☐ |
| X6 | `UAT-TTR-002` customer | `<isSoleTrader>N</isSoleTrader>`, and no `<isAbnHolder>` or `<abn>` | ☐ |
| X7 ⚠ | `UAT-TTR-002` | `<otherPerson …><individualDetails><fullName>Grace Holloway</fullName><altName>Gracie Holloway</altName>` | ☐ |
| X8 | `UAT-TTR-001` and `003` | No `<altName>` inside `<otherPerson>` (they have no conducting person) | ☐ |
| X9 | Whole file | Validate with the XSD command in [dev-test-sheet.md](dev-test-sheet.md) (D35): prints **`0`** errors | ☐ |
| X10 | Every transaction | Straight after `</transaction>`: `<recipient id="…"><sameAsCustomer refId="customer-…-1"/></recipient>` (the customer, since no recipient is recorded) | ☐ |

**What a failure looks like:**
- X1/X2 show **yesterday's date** with a time like `22:35:00` or `21:05:00`. The time is still in UTC.
- X4 shows `<isSoleTrader>N</isSoleTrader>`. The sole-trader answer wasn't saved.
- X7 has no `<altName>`. The conducting person's aliases aren't being loaded.

---

## Sign-off

☐ All checks pass · Notes: ______________________________________________
