# Order-
# QR Menu — Customer Order Panel

Mobile-first QR menu for restaurant tables. Customers browse the menu, enter
their phone number, and place orders through the Billing Panel's secure Firebase
callables. Orders sync to the billing panel through Firestore.

The current login is a temporary bridge while Fast2SMS DLT approval is pending:
existing customers are looked up by phone, new customers confirm their name
before account creation, and new profiles are stored with `phoneVerified: false`.
OTP is not part of the current client flow. The future verification gate can
be enabled in the callable backend without changing customer profiles or the
order schema.
