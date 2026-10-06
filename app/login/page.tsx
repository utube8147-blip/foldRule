// There are no accounts, so there is nothing to log in to. Old links to
// /login land on the profile screen instead.
import { redirect } from 'next/navigation';

export default function Login() {
  redirect('/register');
}
