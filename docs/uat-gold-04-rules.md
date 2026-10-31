# UAT: Gold due diligence rules sign-off

**Purpose:** this is a sign-off table, not a screen test. It is for the client and the compliance officer. Each row is one situation, with the answer the software's rules give. Every row is also an automated test, so what you agree here is what the software will do.

Please read each row and tick **Agree**, or write what you would expect instead. In particular, please confirm:
1. the **$10,000** cash line, and the **$5,000** bullion line for needing a current ID;
2. the **10 business day** deadline (Monday to Friday, public holidays not skipped);
3. the **re-verification window** for a photographed ID (the business setting, currently **730 days**);
4. what makes a sale **case A** (invoice optional, report started later) or **case B** (invoice required now, report opened at the counter);
5. that a **duplicate invoice number blocks** a reportable sale.

Case A depends on the compliance officer's answer on the AML/CTF triggers. If case A is not approved, every reportable sale becomes case B.

| | |
|---|---|
| Build/commit | ________ |
| Reviewed by / date | ________ |

**How to read the table.**
- **Reported?** Does this sale need a Threshold Transaction Report (TTR) to AUSTRAC?
- **Current ID needed?** An expired ID, or one photographed longer ago than the re-verification window, stops the sale being saved ("Update ID now").
- **Blocked?** Whether the sale can be saved as described.
- **Case** A or B, as above. A dash means no report, so no case.
- **Invoice needed now?** Whether the ERP invoice number must be entered before saving.
- **Report due:** the sale date plus 10 business days.

In every row the customer's ID is current unless the row says otherwise, and "the box" means the "ID sighted today and matches the record on file" tick, which is ticked.

## A. Cash amounts

| # | Situation | Reported? | Current ID needed? | Blocked? | Case | Invoice needed now? | Report due | Agree |
|---|---|---|---|---|---|---|---|---|
| A1 | Scrap jewellery, cash $9,999.99 | No | No | No | - | No | - | ☐ |
| A2 | Scrap jewellery, cash exactly $10,000 | Yes | Yes | No | A or B (see section D) | See D | 10 business days | ☐ |
| A3 | Scrap jewellery, "$10,000 or more" answered Yes, no amount entered | Yes | Yes | No | A or B | See D | 10 business days | ☐ |
| A4 | Scrap jewellery, "$10,000 or more" answered Yes, but amount entered is $8,000 | No | No | No | - | No | - | ☐ |
| A5 | Scrap jewellery paid by bank transfer (cash answered No) | No | No | No | - | No | - | ☐ |
| A6 | Bullion, cash under $5,000 | No | No | No | - | No | - | ☐ |
| A7 | Bullion, cash $5,000 to $9,999 | No | Yes | Only if the ID is expired or too old | - | No | - | ☐ |
| A8 | Bullion, "$10,000 or more" answered, but amount entered is $7,000 | No | Yes | Only if the ID is expired or too old | - | No | - | ☐ |
| A9 | Bullion, "$10,000 or more" answered, amount entered is exactly $5,000 | No | Yes | Only if the ID is expired or too old | - | No | - | ☐ |
| A10 | Bullion, "$10,000 or more" answered, amount entered is $4,999.99 | No | No | No | - | No | - | ☐ |
| A11 | Bullion, cash $10,000 or more | Yes | Yes | No | A or B | See D | 10 business days | ☐ |

## B. Several parts on one invoice (same customer, same invoice number, same day)

| # | Situation | Reported? | Current ID needed? | Blocked? | Case | Invoice needed now? | Report due | Agree |
|---|---|---|---|---|---|---|---|---|
| B1 | Scrap $6,000 cash, then bullion $6,000 cash, same invoice INV-900. Total $12,000 | Yes | Yes | No | A or B | See D | 10 business days. Two reports, one per type, $6,000 each, both showing INV-900 | ☐ |
| B2 | Scrap $4,000 cash, then bullion $5,000 cash, same invoice. Total $9,000 | No | Bullion part: Yes ($5,000 or more) | Only if the ID is expired or too old | - | No | - | ☐ |
| B3 | Scrap $9,999.99 cash, then another part of $0.01 cash. Total exactly $10,000 | Yes | Yes | No | A or B | See D | 10 business days | ☐ |
| B4 | Scrap $12,000 cash, with the bullion on the same invoice paid by bank transfer | Yes | Yes | No | A or B | See D | 10 business days. One report only (scrap); no bullion report | ☐ |
| B5 | Another scrap part is added after a scrap report was already started and is still a draft | Yes | Yes | No | Joins the existing report; its cash is updated | See D | Original deadline | ☐ |
| B6 | Another scrap part is added after the scrap report was **completed** | - | - | **Yes.** "The AUSTRAC report for INV-900 is already finished. Use a new ERP invoice number for this purchase." | - | A new invoice number is needed | - | ☐ |
| B7 | Bullion part added when only the **scrap** report was completed | Depends on cash | Depends on cash | No (different type) | - | - | - | ☐ |
| B8 | Same invoice number used on a different day, or for a different customer | Not combined: each sale is judged alone | - | See section E for the duplicate invoice rule | - | - | - | ☐ |

## C. ID checks

| # | Situation | Reported? | Current ID needed? | Blocked? | Case | Invoice needed now? | Report due | Agree |
|---|---|---|---|---|---|---|---|---|
| C1 | Reportable sale, seller's ID has **expired** | Yes | Yes | **Yes.** "Update ID now" | - | - | - | ☐ |
| C2 | Reportable sale, seller's ID was photographed **longer ago than the window** (730 days) | Yes | Yes | **Yes.** "Update ID now" | - | - | - | ☐ |
| C3 | Bullion $5,000 to $9,999, ID expired or too old | No | Yes | **Yes** | - | - | - | ☐ |
| C4 | Joint sale (reportable), the **second** person's ID is expired or too old | Yes | Yes | **Yes**, naming the second person | - | - | - | ☐ |
| C5 | Scrap under $10,000, ID expired | No | No | No. Saved and flagged "ID had expired" | - | No | - | ☐ |
| C6 | Scrap under $10,000, ID too old | No | No | No. Saved with an amber notice | - | No | - | ☐ |
| C7 | Any sale, the "ID sighted today" box not ticked | Any | Any | **Yes.** "ID must be sighted today and match the record on file. Doesn't match the record? Update ID first." | - | - | - | ☐ |
| C8 | Joint sale, the box not ticked | Any | Any | **Yes.** "Both people's IDs must be sighted today..." | - | - | - | ☐ |
| C9 | Completing a saved sale later: the sale is reportable and the ID had expired, or was too old, when it was bought | Yes | Yes | **Yes**, it cannot be completed | - | - | - | ☐ |
| C10 | Completing a saved sale later: the sale is not reportable and the ID was expired or too old when bought | No | No | No | - | Yes, to complete | - | ☐ |
| C11 | Completing a saved sale later: ID was fine at the time, even if it has expired since | Per sale | Per sale | No (judged at the time of sale) | - | Yes, to complete | - | ☐ |

## D. Case A or case B (reportable sales only)

| # | Situation | Reported? | Current ID needed? | Blocked? | Case | Invoice needed now? | Report due | Agree |
|---|---|---|---|---|---|---|---|---|
| D1 | Not reportable | No | - | - | None. The two counter questions are not asked | No | - | ☐ |
| D2 | One seller, every AUSTRAC detail already on file, "acting on their own behalf?" Yes, "details still correct?" Yes | Yes | Yes | No | **A** | No. Optional; the report starts when the invoice is added | 10 business days | ☐ |
| D3 | As D2, but "acting on their own behalf?" is **No** | Yes | Yes | No | **B** | **Yes** | 10 business days | ☐ |
| D4 | As D2, but "details still correct?" is **No** | Yes | Yes | No | **B** | **Yes** | 10 business days | ☐ |
| D5 | As D2, but a question has not been answered | Yes | Yes | No | **B** | **Yes** | 10 business days | ☐ |
| D6 | **Joint** sale (two sellers), even if everything is on file and both answers are Yes | Yes | Yes | No | **B** | **Yes** | 10 business days | ☐ |
| D7 | One seller, but some AUSTRAC details are missing on file (for example a customer only ever seen in gold) | Yes | Yes | No | **B** | **Yes.** "Enter the ERP invoice number. {Name}'s AUSTRAC details are incomplete, so the report must be started now." | 10 business days | ☐ |
| D8 | Case B and the invoice number is entered | Yes | Yes | No | B | Done | 10 business days | ☐ |

## E. Invoice numbers

| # | Situation | Reported? | Current ID needed? | Blocked? | Case | Invoice needed now? | Report due | Agree |
|---|---|---|---|---|---|---|---|---|
| E1 | Reportable sale, invoice number already used on another customer's or another day's purchase | Yes | Yes | **Yes.** "...is already used by another purchase. A reportable purchase needs its own invoice number." | - | - | - | ☐ |
| E2 | Sale that is not reportable, invoice number already used elsewhere | No | - | No. A warning is shown | - | - | - | ☐ |
| E3 | Reportable sale, invoice number used only by an earlier part of the same sale (same customer, same day) | Yes | Yes | No | - | - | - | ☐ |
| E4 | Completing a saved sale: the invoice number is left blank | - | - | **Yes.** An invoice number is required to complete | - | Yes | - | ☐ |
| E5 | Completing a saved sale: its own number is found on itself | - | - | No (it is not a duplicate of itself) | - | - | - | ☐ |
| E6 | Photo only, no invoice, not reportable | No | No | No. Saved as "Incomplete" | - | No | None | ☐ |

## F. Report deadline (10 business days, Monday to Friday, public holidays not skipped)

The deadline is counted from the sale date in **Melbourne time** (Australia/Melbourne), so a sale made early on a Melbourne morning is not counted from the day before.

| # | Situation | Reported? | Current ID needed? | Blocked? | Case | Invoice needed now? | Report due | Agree |
|---|---|---|---|---|---|---|---|---|
| F1 | Reportable sale on **Friday 6 Nov 2026** | Yes | - | - | - | - | **Friday 20 Nov 2026** | ☐ |
| F2 | Reportable sale on **Saturday 7 Nov 2026** (counting starts Monday 9 Nov) | Yes | - | - | - | - | **Friday 20 Nov 2026** | ☐ |
| F3 | Reportable sale on **Sunday 8 Nov 2026** | Yes | - | - | - | - | **Friday 20 Nov 2026** | ☐ |
| F4 | Reportable sale on **Monday 30 Nov 2026** (month end) | Yes | - | - | - | - | **Monday 14 Dec 2026** | ☐ |
| F5 | Reportable sale on **Thursday 29 Oct 2026** (month end) | Yes | - | - | - | - | **Thursday 12 Nov 2026** | ☐ |
| F6 | Reportable sale at 9:30 am Friday 6 Nov 2026 Melbourne time (still Thursday 5 Nov in UTC) | Yes | - | - | - | - | **Friday 20 Nov 2026** (not Thursday 19 Nov) | ☐ |
| F7 | A public holiday falls inside the 10 days (for example Melbourne Cup day, Tuesday 3 Nov 2026) | Yes | - | - | - | - | The holiday still counts as a business day, so the deadline can be a day earlier than the legal one (the safe side) | ☐ |

## Sign-off

By signing, we confirm each row above matches our understanding of the rules (or the exceptions are written next to the row).

Exceptions or changes requested:

________________________________________________________________________

________________________________________________________________________

| | Name | Signature | Date |
|---|---|---|---|
| Client | ________ | ________ | ________ |
| Compliance officer | ________ | ________ | ________ |
| Build/commit | ________ | | |
