import { Transform, type TransformFnParams } from 'class-transformer'
import { IsNotEmpty, Length, Matches, MinLength } from 'class-validator'

export class SignupBodyDto {
  @Matches(/^[a-zA-Z0-9_]+$/, {
    message: 'Login: only latin letters, digits and _',
  })
  @Length(3, 32, { message: 'Login: from 3 to 32 characters' })
  @IsNotEmpty({ message: 'Fill in all fields' })
  @Transform(({ value }: TransformFnParams) => String(value || '').trim())
  username: string

  @Matches(/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, {
    message: 'Invalid email format',
  })
  @Matches(/^[^ ]*$/, { message: 'Email must not contain spaces' })
  @IsNotEmpty({ message: 'Fill in all fields' })
  @Transform(({ value }: TransformFnParams) =>
    String(value || '')
      .trim()
      .toLowerCase(),
  )
  email: string

  @Matches(/\d/, { message: 'Password must contain digits' })
  @Matches(/^[A-Z]/, {
    message: 'Password must start with a capital latin letter (A–Z)',
  })
  @MinLength(8, { message: 'Password must be at least 8 characters long' })
  @IsNotEmpty({ message: 'Fill in all fields' })
  @Transform(({ value }: TransformFnParams) => String(value || ''))
  password: string
}
