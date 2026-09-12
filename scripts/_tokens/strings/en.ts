/**
 * Driver app English strings — source of truth for typed translation keys.
 */
export const stringsEn = {
  'auth.login.title': 'Login to get started',
  'auth.login.countryCode': '+91',
  'auth.login.mobilePlaceholder': 'Enter mobile number',
  'auth.login.info':
    "We'll text you a one-time code. Your number stays private — riders never see it directly, calls are always routed through masked numbers.",
  'auth.login.continue': 'Continue',
  'auth.login.or': 'or',
  'auth.login.google': 'Continue with Google',
  'auth.login.language': 'Language: {language}',
  'auth.login.termsPrefix': 'By continuing you agree to our',
  'auth.login.terms': 'Terms & Conditions',
  'auth.login.and': 'and',
  'auth.login.privacy': 'Privacy Policy',
  'auth.header.partner': 'PARTNER',
  'auth.header.tagline': 'DRIVE • EARN • BELONG',
  'auth.otp.title': 'OTP Verification',
  'auth.otp.sentTo': 'Sent to +91 {mobile}',
  'auth.otp.edit': 'Edit',
  'auth.otp.verify': 'Verify',
  'auth.otp.didntReceive': "Didn't receive code?",
  'auth.otp.resend': 'Resend',
  'auth.otp.resendIn': 'in {timer}',

  'permissions.notification.skip': 'Skip',
  'permissions.notification.title': 'Stay Updated',
  'permissions.notification.body':
    'Enable notifications to get real-time updates about your rides, drivers, and safety alerts.',
  'permissions.notification.enable': 'Enable Notifications',
  'permissions.notification.later': 'Maybe Later',

  'docs.upload.title': 'Upload Your Documents',
  'docs.upload.subtitle':
    'Add a clear photo of each document. Our team verifies most within a few hours so you can start earning.',
  'docs.upload.required': 'Required Documents',
  'docs.upload.drivingLicence': 'Driving Licence',
  'docs.upload.rc': 'Vehicle Registration (RC)',
  'docs.upload.insurance': 'Insurance Certificate',
  'docs.upload.puc': 'PUC Certificate',
  'docs.upload.permit': 'Permit (Taxi / Transport)',
  'docs.upload.fitness': 'Fitness Certificate',
  'docs.upload.aadhaar': 'Aadhaar Card',
  'docs.upload.pan': 'PAN Card',
  'docs.status.uploaded': 'Uploaded',
  'docs.status.verified': 'Verified',
  'docs.status.pending': 'Pending',
  'docs.status.expired': 'Expired',
  'docs.list.mandatory': 'Mandatory',
  'docs.list.upload': 'Upload',
  'docs.bottom.complete': 'Complete verification to go online',
  'docs.bottom.hint': 'Once all documents are verified, you can start receiving ride requests',
  'docs.bottom.continue': 'Continue',
  'docs.detail.save': 'Save & Continue',
  'docs.detail.fileUploaded': 'File uploaded',
  'docs.detail.replace': 'Tap here to replace',
  'docs.success.title': 'Documents Uploaded',
  'docs.success.great': 'Great! Your documents have been submitted.',
  'docs.success.body':
    "We've received all your documents and our team will review them. You'll be notified once verified.",
  'docs.success.process': 'Verification Process',
  'docs.success.explore': 'Explore the App',

  'tabs.home': 'Home',
  'tabs.earnings': 'Earnings',
  'tabs.security': 'Security',
  'tabs.activity': 'Activity',
  'tabs.account': 'Account',

  'security.placeholder':
    'Emergency SOS and safety tools will appear here. Stay safe on every trip.',

  'home.online': 'You are Online',
  'home.offline': 'You are Offline',
  'home.ready': 'Ready to receive ride requests',
  'home.tapOnline': 'Tap to go online and start receiving ride requests',
  'home.autoAccept': 'Auto Accept',
  'home.on': 'On',
  'home.dutyHours': 'Duty Hours',
  'home.demand': 'Demand in your area',
  'home.low': 'Low',
  'home.highDemand': 'High Demand',
  'home.nextPickup': 'Next Schedule Pickup',
  'home.estFare': 'Est. Fare',
  'home.offlineHint':
    'Go online to view your dashboard, incentives and scheduled pickups, and to accept ride requests.',

  'ride.incoming.title': 'Incoming Ride Request',
  'ride.incoming.subtitle': 'New ride request, please respond',
  'ride.incoming.acceptIn': 'Accept in',
  'ride.incoming.sec': 'sec',
  'ride.incoming.earning': 'Your Earning',
  'ride.incoming.accept': 'Accept the Ride',
  'ride.incoming.decline': 'Decline',

  'common.continue': 'Continue',
  'common.cancel': 'Cancel',
  'common.save': 'Save',
  'common.loading': 'Loading…',
} as const;

export type TranslationKey = keyof typeof stringsEn;
